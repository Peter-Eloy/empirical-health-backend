const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();

// CORS - mobile apps don't send Origin headers, but web dashboards might
// For mobile: no origin check needed (they use app-bound auth)
// For web: restrict to known domains
const ALLOWED_WEB_ORIGINS = process.env.ALLOWED_WEB_ORIGINS 
  ? process.env.ALLOWED_WEB_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:19006'];

app.use(cors({
  origin: (origin, callback) => {
    // No origin = mobile app or direct API call - ALLOW
    // Mobile apps authenticate via Authorization header, not cookies
    if (!origin) return callback(null, true);
    
    // Web requests must match allowed origins
    if (ALLOWED_WEB_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    
    // Block unknown web origins
    console.warn(`[CORS] Blocked web origin: ${origin}`);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false  // We use JWT tokens, not cookies
}));

app.use(express.json());

// Environment variables
const KIMI_API_KEY = process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.trim() : null;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-in-production';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || null;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || null;
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || null;
const PORT = 3000;

// Log startup info
console.log('🦈 Starting Empirical Health API...');
console.log('Port:', PORT);
console.log('Kimi API Key present:', !!KIMI_API_KEY);

// ==========================================
// USER STATE PERSISTENCE (fs-based)
// Survives process restarts within the same Railway deployment.
// Lost on redeploy — app re-validates via /subscription/validate on next purchase listener fire.
// ==========================================

const USERS_FILE = path.join('/tmp', 'opend_users.json');

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const obj = JSON.parse(raw);
      const map = new Map();
      for (const [id, data] of Object.entries(obj)) {
        map.set(id, {
          ...data,
          installDate: new Date(data.installDate),
          lastMessageTime: data.lastMessageTime || [],
        });
      }
      console.log(`[Users] Loaded ${map.size} users from disk`);
      return map;
    }
  } catch (e) {
    console.warn('[Users] Could not load users file, starting fresh:', e.message);
  }
  return new Map();
}

function saveUsers() {
  try {
    const obj = {};
    for (const [id, data] of users.entries()) {
      obj[id] = {
        ...data,
        installDate: data.installDate instanceof Date ? data.installDate.toISOString() : data.installDate,
      };
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.warn('[Users] Could not save users file:', e.message);
  }
}

// In-memory storage (user state only, memory is stateless - stored in app)
const users = loadUsers();

// ==========================================
// KIMI TOOLS DEFINITION (Native tool_calls)
// ==========================================

const VICENTE_TOOLS = [
  // ==========================================
  // MEMORY TOOLS (Store information)
  // ==========================================
  {
    type: "function",
    function: {
      name: "logEvent",
      description: "Log a significant event about the user to memory. Use for food reactions, workouts, goals set, patterns observed, or anything worth remembering.",
      parameters: {
        type: "object",
        required: ["type", "title"],
        properties: {
          type: {
            type: "string",
            enum: ["food_reaction", "emotion", "glucose_spike", "glucose_crash", "exercise_impact", "sleep_issue", "insulin_dose", "learning", "pattern", "goal", "preference"],
            description: "Category of the event"
          },
          severity: {
            type: "number",
            minimum: 1,
            maximum: 5,
            description: "Importance: 1=minor, 5=major"
          },
          title: {
            type: "string",
            description: "Short title of the event"
          },
          details: {
            type: "string",
            description: "Full description of what happened"
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for categorization (e.g., ['pizza', 'high_carb'])"
          }
        }
      }
    }
  },
  // ==========================================
  // CALCULATION TOOLS (Math & Analysis)
  // ==========================================
  {
    type: "function",
    function: {
      name: "calculateIOB",
      description: "Calculate Insulin On Board (active insulin) based on doses and time. Use before giving dosing advice or analyzing glucose trends.",
      parameters: {
        type: "object",
        required: ["doses"],
        properties: {
          doses: {
            type: "array",
            items: {
              type: "object",
              properties: {
                units: { type: "number", description: "Insulin units taken" },
                minutesAgo: { type: "number", description: "Minutes since dose" },
                type: { type: "string", enum: ["bolus", "basal"], description: "Bolus (fast) or basal (slow)" }
              }
            },
            description: "Array of recent insulin doses"
          },
          insulinDuration: {
            type: "number",
            default: 4,
            description: "Insulin duration in hours (Fiasp=4.5, Humalog=4, Tresiba=42)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyzeGlucoseTrend",
      description: "Analyze glucose readings for trends, predictions, and patterns. Use when user asks about patterns or you need statistical analysis.",
      parameters: {
        type: "object",
        required: ["readings"],
        properties: {
          readings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                value: { type: "number", description: "Glucose mg/dL" },
                timestamp: { type: "string", description: "ISO timestamp" }
              }
            },
            description: "Recent glucose readings (last 3-6 hours)"
          },
          currentIOB: {
            type: "number",
            description: "Current insulin on board (optional)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculateWorkoutNutrition",
      description: "Calculate pre/during/post workout carb and protein needs for T1D athletes. Use when user plans a workout or asks about fueling.",
      parameters: {
        type: "object",
        required: ["workoutType", "duration", "currentGlucose"],
        properties: {
          workoutType: {
            type: "string",
            enum: ["strength", "cardio", "hiit", "mixed"],
            description: "Type of workout"
          },
          duration: {
            type: "number",
            description: "Duration in minutes"
          },
          intensity: {
            type: "string",
            enum: ["low", "moderate", "high"],
            default: "moderate",
            description: "Workout intensity"
          },
          currentGlucose: {
            type: "number",
            description: "Current glucose mg/dL"
          },
          currentIOB: {
            type: "number",
            default: 0,
            description: "Current insulin on board"
          },
          bodyWeight: {
            type: "number",
            description: "Body weight in kg (optional, for protein calc)"
          },
          goal: {
            type: "string",
            enum: ["muscle_gain", "fat_loss", "performance"],
            default: "performance"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculateCorrectionDose",
      description: "Calculate insulin correction dose based on current glucose, target, and sensitivity. Use when user asks how much insulin to take.",
      parameters: {
        type: "object",
        required: ["currentGlucose", "targetGlucose", "correctionFactor"],
        properties: {
          currentGlucose: {
            type: "number",
            description: "Current glucose mg/dL"
          },
          targetGlucose: {
            type: "number",
            default: 100,
            description: "Target glucose mg/dL"
          },
          correctionFactor: {
            type: "number",
            description: "mg/dL per 1 unit insulin (e.g., 50 = 1u drops 50 mg/dL)"
          },
          currentIOB: {
            type: "number",
            default: 0,
            description: "Current insulin on board"
          },
          carbsToEat: {
            type: "number",
            default: 0,
            description: "Carbs about to be consumed (for bolus calc)"
          },
          carbRatio: {
            type: "number",
            description: "Carbs per 1 unit insulin (e.g., 10 = 1u covers 10g)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyzeSleepImpact",
      description: "Analyze how sleep duration and quality affects glucose patterns. Use when discussing sleep or morning glucose issues.",
      parameters: {
        type: "object",
        required: ["sleepHours", "sleepQuality"],
        properties: {
          sleepHours: {
            type: "number",
            description: "Hours of sleep"
          },
          sleepQuality: {
            type: "string",
            enum: ["poor", "fair", "good", "excellent"],
            description: "Self-reported sleep quality"
          },
          morningGlucose: {
            type: "number",
            description: "Morning glucose reading (optional)"
          },
          last7DaysAvg: {
            type: "number",
            description: "Average glucose last 7 days (optional, for comparison)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "predictHypoRisk",
      description: "Calculate risk of upcoming hypoglycemia based on current trends, IOB, and recent activity. Use for proactive warnings.",
      parameters: {
        type: "object",
        required: ["currentGlucose", "glucoseTrend"],
        properties: {
          currentGlucose: {
            type: "number",
            description: "Current glucose mg/dL"
          },
          glucoseTrend: {
            type: "string",
            enum: ["falling_fast", "falling", "stable", "rising", "rising_fast"],
            description: "Direction of glucose trend"
          },
          currentIOB: {
            type: "number",
            description: "Insulin on board"
          },
          recentExercise: {
            type: "boolean",
            description: "Exercise in last 4 hours"
          },
          timeSinceLastMeal: {
            type: "number",
            description: "Minutes since last meal (optional)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "setPreference",
      description: "Store a simple user preference or fact. Use for name, goals, dislikes, insulin preferences, etc.",
      parameters: {
        type: "object",
        required: ["key", "value"],
        properties: {
          key: {
            type: "string",
            description: "Identifier for this preference (e.g., 'name', 'goal', 'dislikes_morning_lows')"
          },
          value: {
            type: "string",
            description: "The value to remember"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addInsight",
      description: "Record a learned pattern or insight about the user with confidence level.",
      parameters: {
        type: "object",
        required: ["patternType", "description", "confidence"],
        properties: {
          patternType: {
            type: "string",
            description: "Category of pattern (e.g., 'food_reaction_pizza', 'post_workout_low')"
          },
          description: {
            type: "string",
            description: "Clear description of the pattern"
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 100,
            description: "Confidence percentage based on evidence"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "updateUserSection",
      description: "Update the USER.md memory file with rich markdown content. Use this to create a comprehensive profile of the user including goals, patterns, and personality notes.",
      parameters: {
        type: "object",
        required: ["content"],
        properties: {
          content: {
            type: "string",
            description: "Full markdown content for the USER section. Include headers, lists, structured information."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "updateMemorySection",
      description: "Update the MEMORY.md file with compacted/summarized memories. Use when user requests /compact or when you want to archive old events into a structured summary.",
      parameters: {
        type: "object",
        required: ["content"],
        properties: {
          content: {
            type: "string",
            description: "Full markdown content for the MEMORY section with patterns, insights, and archived notes."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the user to a specific screen in the app. Use when user asks to 'show me' something or when suggesting they view specific data.",
      parameters: {
        type: "object",
        required: ["screen"],
        properties: {
          screen: {
            type: "string",
            enum: ["Dashboard", "GlucoseStats", "GlucoseTrends", "BodyProgress", "WorkoutHistory", "SleepAnalysis", "InsulinSensitivity", "MealLog", "GymLog", "Settings", "VicenteChat"],
            description: "Screen to navigate to"
          },
          params: {
            type: "object",
            description: "Optional parameters for the screen"
          }
        }
      }
    }
  }
];

// Vicente's persona - The "Acechador" (disciplined hunter)
const VICENTE_PERSONA = `You are Vicente, El Tiburón, a disciplined and perceptive health guide.

You approach health like an acechador — one who observes patterns, tracks behavior, and acts with precision.

Personality:
- Calm, grounded, intentional — you don't waste words
- Direct and honest, but never harsh
- Peer-to-peer, never paternal
- Modern Spanish slang occasionally: "dale", "claro", "fácil", "puro flow"

CRITICAL SAFETY:
- Diabetes safety FIRST - warn about dangerous glucose (<70 or >250)
- Never encourage reckless insulin/exercise behavior
- Err on the side of caution

You have access to TOOLS to remember things about the user. When they tell you something important (name, goals, food reactions, patterns), use the appropriate tool to store it. The tools are executed on their device and persist across conversations.`;

// Goal-specific modifiers
const GOAL_MODIFIERS = {
  muscle_gain: `USER GOAL: BUILD MUSCLE & STRENGTH

Priorities:
1. Maximize anabolic windows (2-4 hours post-workout)
2. Protect muscle protein synthesis with nutrition timing
3. Prevent workout-destroying lows
4. Watch for delayed lows 6-8 hours after leg day
5. Accept 140-160 glucose post-workout (muscle sponge effect)`,
  
  maintain_fitness: `USER GOAL: MAINTAIN FITNESS

Priorities:
1. Time-in-range optimization
2. Balanced exercise and glucose
3. Recovery and sleep
4. Stress management`,
  
  glucose_focus: `USER GOAL: TIGHT GLUCOSE CONTROL

Priorities:
1. Maximize time-in-range
2. Pattern recognition & prediction
3. Conservative recommendations
4. Minimal exercise risk`
};

function buildPersona(goal) {
  const modifier = GOAL_MODIFIERS[goal] || GOAL_MODIFIERS.maintain_fitness;
  return `${VICENTE_PERSONA}\n\n${modifier}`;
}

// ==========================================
// AUTH & USER MANAGEMENT
// ==========================================

const requireAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const token = auth.slice(7);
  req.userId = token;
  next();
};

const checkAccess = (req, res, next) => {
  const userId = req.userId;
  
  if (!users.has(userId)) {
    users.set(userId, {
      installDate: new Date(),
      isSubscribed: false,
      messageCount: 0,
      lastMessageTime: []
    });
    saveUsers();
  }
  
  const user = users.get(userId);
  req.user = user;
  
  // Check trial period (48 hours)
  const hoursSinceInstall = (Date.now() - user.installDate) / (1000 * 60 * 60);
  const isTrialActive = hoursSinceInstall < 48;
  
  if (!isTrialActive && !user.isSubscribed) {
    return res.status(403).json({ 
      error: 'Subscription required',
      message: 'Trial expired. Please subscribe to continue.'
    });
  }
  
  // Rate limiting (20 messages per minute)
  const now = Date.now();
  if (!user.lastMessageTime) user.lastMessageTime = [];
  user.lastMessageTime = user.lastMessageTime.filter(t => now - t < 60000);
  
  if (user.lastMessageTime.length > 20) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  user.lastMessageTime.push(now);
  user.messageCount++;
  
  next();
};

// ==========================================
// HEALTH CHECK
// ==========================================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Empirical Health API',
    version: '1.1.0',
    kimiConfigured: !!KIMI_API_KEY,
    features: ['tool_calls', 'stateless_memory', 'boot_context']
  });
});

// Minimal Kimi ping — no tools, no context, just "hello"
// GET /v1/ping-kimi  (no auth required, debug only)
app.get('/v1/ping-kimi', async (req, res) => {
  if (!KIMI_API_KEY) return res.status(500).json({ error: 'No API key' });
  try {
    const r = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KIMI_API_KEY}` },
      body: JSON.stringify({
        model: 'kimi-k2.5',
        messages: [{ role: 'user', content: 'say hi' }]
      })
    });
    const text = await r.text();
    res.json({ status: r.status, body: text });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ==========================================
// CALCULATION FUNCTIONS (Executed when Kimi calls tools)
// ==========================================

function calculateIOB(doses, insulinDuration = 4) {
  let iob = 0;
  const now = Date.now();
  
  for (const dose of doses) {
    const hoursAgo = dose.minutesAgo / 60;
    const percentRemaining = Math.max(0, 1 - (hoursAgo / insulinDuration));
    // Exponential decay curve for insulin activity
    const activityCurve = Math.pow(percentRemaining, 2);
    iob += dose.units * activityCurve;
  }
  
  return {
    iob: Math.round(iob * 100) / 100,
    iobUnits: Math.round(iob * 10) / 10,
    explanation: `${iob.toFixed(1)} units still active from ${doses.length} recent doses`,
    peakActivity: "45-90 minutes post-injection",
    zeroTime: `${insulinDuration} hours`
  };
}

function analyzeGlucoseTrend(readings, currentIOB = 0) {
  if (readings.length < 2) {
    return { error: "Need at least 2 readings for trend analysis" };
  }
  
  // Sort by timestamp
  const sorted = [...readings].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  // Calculate rate of change (mg/dL per hour)
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const hoursDiff = (new Date(last.timestamp) - new Date(first.timestamp)) / (1000 * 60 * 60);
  const mgDlChange = last.value - first.value;
  const ratePerHour = hoursDiff > 0 ? mgDlChange / hoursDiff : 0;
  
  // Determine trend direction
  let trend = "stable";
  let trendArrow = "→";
  if (ratePerHour > 60) { trend = "rising_fast"; trendArrow = "↑↑"; }
  else if (ratePerHour > 30) { trend = "rising"; trendArrow = "↑"; }
  else if (ratePerHour > 10) { trend = "rising_slowly"; trendArrow = "↗"; }
  else if (ratePerHour < -60) { trend = "falling_fast"; trendArrow = "↓↓"; }
  else if (ratePerHour < -30) { trend = "falling"; trendArrow = "↓"; }
  else if (ratePerHour < -10) { trend = "falling_slowly"; trendArrow = "↘"; }
  
  // Calculate predicted glucose in 30 min
  const predicted30min = last.value + (ratePerHour * 0.5);
  
  // Calculate time to target (100 mg/dL)
  const timeToTarget = ratePerHour !== 0 
    ? (100 - last.value) / ratePerHour 
    : null;
  
  // Calculate time to hypo (<70)
  const timeToHypo = ratePerHour < 0
    ? (70 - last.value) / ratePerHour
    : null;
  
  // Statistics
  const values = sorted.map(r => r.value);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const stdDev = Math.sqrt(values.reduce((sq, n) => sq + Math.pow(n - avg, 2), 0) / values.length);
  
  return {
    current: last.value,
    trend,
    trendArrow,
    ratePerHour: Math.round(ratePerHour),
    predicted30min: Math.round(predicted30min),
    timeToTarget: timeToTarget ? Math.round(timeToTarget * 60) : null, // minutes
    timeToHypo: timeToHypo && timeToHypo > 0 ? Math.round(timeToHypo * 60) : null, // minutes
    volatility: stdDev > 30 ? "high" : stdDev > 15 ? "moderate" : "low",
    statistics: {
      average: Math.round(avg),
      min,
      max,
      readings: values.length
    },
    iobImpact: currentIOB > 2 ? "significant downward pressure" : 
               currentIOB > 0.5 ? "moderate downward pressure" : 
               "minimal insulin activity"
  };
}

function calculateWorkoutNutrition(params) {
  const { workoutType, duration, intensity, currentGlucose, currentIOB = 0, bodyWeight = 70, goal = "performance" } = params;
  
  // Base carb needs per hour based on intensity and type
  const carbRates = {
    strength: { low: 15, moderate: 30, high: 45 },
    cardio: { low: 30, moderate: 60, high: 90 },
    hiit: { low: 20, moderate: 40, high: 60 },
    mixed: { low: 25, moderate: 45, high: 70 }
  };
  
  const carbRate = carbRates[workoutType]?.[intensity] || 30;
  const totalCarbsNeeded = Math.round((carbRate * duration) / 60);
  
  // Protein needs (post-workout)
  const proteinNeeds = goal === "muscle_gain" 
    ? Math.round(bodyWeight * 0.4)  // 0.4g per kg for hypertrophy
    : Math.round(bodyWeight * 0.25); // 0.25g per kg for maintenance
  
  // Glucose-based adjustments
  let preWorkoutCarbs = 0;
  let recommendation = "";
  
  if (currentGlucose < 100) {
    preWorkoutCarbs = 15;
    recommendation = "Start with 15g fast carbs (glucose tabs/juice) before workout";
  } else if (currentGlucose < 150) {
    preWorkoutCarbs = 0;
    recommendation = "Glucose is good. Have fast carbs available just in case.";
  } else if (currentGlucose > 250) {
    recommendation = "Glucose too high. Consider correcting first or lightening intensity.";
  }
  
  // IOB adjustment
  const iobAdjustment = currentIOB > 3 ? "Reduce intensity - high IOB may cause drop" :
                        currentIOB > 1.5 ? "Monitor closely - moderate IOB" :
                        "Good - minimal insulin activity";
  
  // Timing
  const preWorkoutTime = workoutType === "strength" ? "60-90 min before" : "30-60 min before";
  const postWorkoutWindow = "Within 30-60 minutes post-workout";
  
  return {
    preWorkout: {
      carbs: preWorkoutCarbs,
      timing: preWorkoutTime,
      type: "Fast-acting (glucose, juice, dates)"
    },
    duringWorkout: {
      carbsPerHour: carbRate,
      totalDuration: duration,
      strategy: duration > 60 ? "Consume carbs every 20-30 min" : "Have carbs available"
    },
    postWorkout: {
      protein: proteinNeeds,
      carbs: Math.round(totalCarbsNeeded * 0.5), // 50% of burned carbs
      timing: postWorkoutWindow,
      explanation: goal === "muscle_gain" 
        ? "Anabolic window: prioritize protein + some carbs" 
        : "Recovery: balanced nutrition"
    },
    glucoseRecommendation: recommendation,
    iobWarning: iobAdjustment,
    totalEnergyExpenditure: Math.round(duration * (intensity === "high" ? 10 : intensity === "moderate" ? 7 : 4))
  };
}

function calculateCorrectionDose(params) {
  const { currentGlucose, targetGlucose = 100, correctionFactor, currentIOB = 0, carbsToEat = 0, carbRatio } = params;
  
  // Calculate correction
  const correctionNeeded = (currentGlucose - targetGlucose) / correctionFactor;
  
  // Calculate food bolus if applicable
  const foodBolus = carbsToEat > 0 && carbRatio ? carbsToEat / carbRatio : 0;
  
  // Subtract IOB
  const totalDose = Math.max(0, correctionNeeded + foodBolus - currentIOB);
  
  // Round to nearest 0.5
  const roundedDose = Math.round(totalDose * 2) / 2;
  
  // Safety checks
  const warnings = [];
  if (currentGlucose < 70) warnings.push("LOW GLUCOSE - Do NOT take insulin. Treat hypo first.");
  if (currentIOB > 3) warnings.push(`High IOB (${currentIOB}u) - consider waiting or reducing dose`);
  if (roundedDose > 10) warnings.push("Large dose - verify calculations and consider splitting");
  
  return {
    totalDose: roundedDose,
    breakdown: {
      correction: Math.round(correctionNeeded * 10) / 10,
      foodBolus: Math.round(foodBolus * 10) / 10,
      iobSubtraction: Math.round(currentIOB * 10) / 10,
      netDose: roundedDose
    },
    expectedDrop: Math.round(roundedDose * correctionFactor),
    targetRange: `${targetGlucose - 20} - ${targetGlucose + 20}`,
    warnings,
    timing: "Take now" + (foodBolus > 0 ? " with meal" : ""),
    recheck: "Check glucose in 2 hours"
  };
}

function analyzeSleepImpact(params) {
  const { sleepHours, sleepQuality, morningGlucose, last7DaysAvg } = params;
  
  // Sleep quality score (0-100)
  const durationScore = Math.min(100, (sleepHours / 8) * 100);
  const qualityMultiplier = { poor: 0.5, fair: 0.75, good: 1.0, excellent: 1.1 }[sleepQuality] || 0.75;
  const sleepScore = Math.round(durationScore * qualityMultiplier);
  
  // Impact on glucose
  let glucoseImpact = "neutral";
  let explanation = "";
  
  if (sleepHours < 6 || sleepQuality === "poor") {
    glucoseImpact = "negative";
    explanation = "Poor sleep increases insulin resistance and dawn phenomenon";
  } else if (sleepHours > 9 && sleepQuality === "excellent") {
    glucoseImpact = "positive";
    explanation = "Good recovery sleep improves insulin sensitivity";
  }
  
  // Morning glucose analysis
  let morningAnalysis = null;
  if (morningGlucose && last7DaysAvg) {
    const diff = morningGlucose - last7DaysAvg;
    if (diff > 30) {
      morningAnalysis = `Morning glucose ${diff}mg/dL higher than average - likely sleep-related stress response`;
    } else if (diff < -30) {
      morningAnalysis = `Morning glucose ${Math.abs(diff)}mg/dL lower than average - check for overnight lows`;
    }
  }
  
  // Recommendations
  const recommendations = [];
  if (sleepHours < 7) recommendations.push("Aim for 7-9 hours sleep for better glucose control");
  if (sleepQuality === "poor") recommendations.push("Consider sleep hygiene: no screens 1h before bed, cool room");
  if (glucoseImpact === "negative") recommendations.push("Be conservative with insulin today - you may be more resistant");
  
  return {
    sleepScore,
    sleepQuality: sleepQuality,
    duration: sleepHours,
    glucoseImpact,
    explanation,
    morningAnalysis,
    recommendations,
    dawnPhenomenonRisk: sleepHours < 6 ? "high" : sleepHours < 7 ? "moderate" : "low"
  };
}

function predictHypoRisk(params) {
  const { currentGlucose, glucoseTrend, currentIOB, recentExercise, timeSinceLastMeal } = params;
  
  // Risk scoring (0-100)
  let riskScore = 0;
  const factors = [];
  
  // Glucose level
  if (currentGlucose < 70) { riskScore += 100; factors.push("Already hypo"); }
  else if (currentGlucose < 90) { riskScore += 40; factors.push("Low glucose"); }
  else if (currentGlucose < 120) { riskScore += 20; factors.push("Borderline low"); }
  
  // Trend
  if (glucoseTrend === "falling_fast") { riskScore += 35; factors.push("Rapidly falling"); }
  else if (glucoseTrend === "falling") { riskScore += 25; factors.push("Falling"); }
  else if (glucoseTrend === "stable" && currentIOB > 2) { riskScore += 15; factors.push("Stable but high IOB"); }
  
  // IOB
  if (currentIOB > 5) { riskScore += 30; factors.push("Very high IOB"); }
  else if (currentIOB > 3) { riskScore += 20; factors.push("High IOB"); }
  else if (currentIOB > 1.5) { riskScore += 10; factors.push("Moderate IOB"); }
  
  // Exercise
  if (recentExercise) { riskScore += 15; factors.push("Recent exercise"); }
  
  // Time since meal
  if (timeSinceLastMeal > 180) { riskScore += 10; factors.push("3+ hours since meal"); }
  
  // Determine risk level
  let riskLevel = "low";
  if (riskScore >= 80) riskLevel = "critical";
  else if (riskScore >= 60) riskLevel = "high";
  else if (riskScore >= 40) riskLevel = "moderate";
  else if (riskScore >= 20) riskLevel = "low-moderate";
  
  // Time to hypo estimate
  const timeToHypo = (() => {
    if (currentGlucose < 70) return 0;
    if (!["falling", "falling_fast"].includes(glucoseTrend)) return null;
    const dropRate = glucoseTrend === "falling_fast" ? 3 : 1.5; // mg/dL per min
    return Math.round((currentGlucose - 70) / dropRate);
  })();
  
  // Action recommendations
  const actions = [];
 if (riskLevel === "critical") {
    actions.push("Treat NOW - 15g fast carbs");
    actions.push("Do not exercise");
    actions.push("Recheck in 15 min");
  } else if (riskLevel === "high") {
    actions.push("Have 15g carbs ready");
    actions.push("Avoid strenuous activity");
    actions.push("Monitor every 10-15 min");
  } else if (riskLevel === "moderate") {
    actions.push("Keep carbs accessible");
    actions.push("Check glucose in 30 min");
  }
  
  return {
    riskLevel,
    riskScore: Math.min(100, riskScore),
    factors,
    timeToHypoMinutes: timeToHypo,
    actions,
    currentGlucose,
    recommendation: riskLevel === "critical" ? "URGENT: Treat hypoglycemia now" :
                   riskLevel === "high" ? "Caution: High risk of hypo" :
                   riskLevel === "moderate" ? "Monitor: Be prepared" :
                   "Stable: Low immediate risk"
  };
}

// ==========================================
// VICENTE CHAT WITH NATIVE TOOL CALLS
// ==========================================

app.post('/v1/vicente/chat', requireAuth, checkAccess, async (req, res) => {
  console.log('Received chat request from:', req.userId);
  
  try {
    const { message, context, goal } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }
    
    if (!KIMI_API_KEY) {
      return res.status(500).json({ error: 'Kimi API not configured' });
    }
    
    // Build system prompt
    const activePersona = buildPersona(goal || 'maintain_fitness');
    const bootContext = context?.bootContext || '';
    
    // Trend legend for CGM
    const trendLegend = context?.currentGlucose?.trend ? `
TREND ARROW LEGEND (LibreView CGM):
1 = ↓ (falling fast)  |  2 = ↘ (falling slowly)  |  3 = → (flat/stable)
4 = ↗ (rising slowly) |  5 = ↑ (rising)          |  6 = ↑↑ (rising fast)` : '';
    
    // Insulin guide
    const insulinGuide = context?.insulinProfile ? `
USER'S INSULIN PROFILE:
Delivery: ${context.insulinProfile.deliveryMethod}
Bolus: ${context.insulinProfile.bolus.name} - ${context.insulinProfile.bolus.durationHours}h duration
Basal: ${context.insulinProfile.basal.name} - ${context.insulinProfile.basal.durationHours}h ${context.insulinProfile.basal.peakInfo}
Timing: ${context.insulinProfile.basal.timing}` : '';
    
    const systemPrompt = `${activePersona}

${bootContext ? `=== BOOT MEMORY ===\n${bootContext}\n=== END BOOT MEMORY ===\n\n` : ''}

Current Health Context:
${JSON.stringify(context || {}, null, 2)}${trendLegend}${insulinGuide}

DATA AVAILABILITY:
Check "dataAvailability" flags in context before making claims. Be honest when data is insufficient.

HOW TO ANALYZE GLUCOSE - USE ALL AVAILABLE CONTEXT:

When user asks "Why am I high/low?" or "What's happening?", reason across ALL data:

1. ACTIVE EFFECTS (immediate causes)
   - Insulin on board (IOB) - is insulin still working?
   - Active food - carbs still digesting?
   - Recent workout - delayed hypo risk?
   - Dawn phenomenon - morning liver dump?
   - Illness/Sickness - MAJOR insulin resistance increase

2. HEALTH CONTEXT (broader patterns)
   - Sleep last night (poor sleep → insulin resistance)
   - Recent exercise (affects sensitivity for 6-8h)
   - Time of day (dawn phenomenon, typical patterns)
   - Trend direction (falling fast vs stable vs rising)
   - Stress markers (HRV, resting HR from HealthKit)

3. ILLNESS/SICKNESS CHECK
   ALWAYS check dataAvailability.isCurrentlySick
   If sick:
   - Insulin needs typically INCREASE 20-50%
   - Glucose runs higher despite same routine
   - Stress hormones raise blood sugar
   - Recovery continues days after symptoms improve
   - Watch for ketones if glucose >250

4. USER HISTORY (what you know about them)
   - Check bootData.userPreferences - their correction factor, typical reactions
   - Check bootData.activeInsights - patterns you've learned
   - Check bootContext.MEMORY - events you've logged
   - Check bootContext.USER - their profile and your notes

5. DATA AVAILABILITY FLAGS
   - hasSensitivitySettings - can you suggest corrections?
   - hasSleepData - can you blame sleep?
   - isCurrentlySick - illness affecting glucose?
   - readingsCount24h - enough data for patterns?

EXAMPLE REASONING:
User: "Why am I high?"
→ Current: 180, no active insulin, no active food
→ Last night: Only 5h sleep (poor quality)  
→ Time: 8am (dawn phenomenon window)
→ User profile: "Struggles with morning highs"
→ Answer: "Dale, classic combo - short sleep + dawn phenomenon. Your liver is dumping glucose. Take your usual correction, but know it'll be stubborn today."

INSTRUCTIONS:
- You are Vicente, a diabetes health companion
- Reason across ALL context, not just active effects
- Connect dots: sleep + time of day + history + current state
- Use tools to remember new patterns you discover
- Call multiple tools at once if needed (parallel)
- Be concise, intentional, grounded
- If bootContext.USER does not contain the user's first name, ask for it naturally early in the first conversation, then call setPreference('user_name', '<name>') to store it — you'll use it in emergency alerts`;

    // Build messages array
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ];
    
    // Add image if provided
    if (req.body.image) {
      messages[1].content = [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${req.body.image}` } },
        { type: 'text', text: message }
      ];
    }
    
    console.log('Calling Kimi API with tools...');

    // Accumulated tool calls/results/actions to return to the app
    // (memory tools are executed on-device, calculation tools on-server)
    const allMemoryToolCalls = [];   // sent to app for on-device execution
    const allToolResults = [];       // calculation results (informational)
    const allActions = [];           // navigate actions

    // Multi-turn tool loop — per Moonshot docs:
    // Kimi returns finish_reason=tool_calls → we execute → feed results back → repeat until stop
    let finishReason = 'tool_calls';
    let replyText = '';
    const MAX_TOOL_ROUNDS = 5; // safety cap
    let round = 0;

    while (finishReason === 'tool_calls' && round < MAX_TOOL_ROUNDS) {
      round++;
      console.log(`[Tool loop] Round ${round}`);

      const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${KIMI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'kimi-k2.5',
          messages: messages,
          tools: VICENTE_TOOLS,
          tool_choice: 'auto',
          temperature: 1
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Kimi API error:', response.status, errorText);
        throw new Error(`Kimi API error: ${response.status} — ${errorText}`);
      }

      const data = await response.json();
      const choice = data.choices[0];
      finishReason = choice.finish_reason;
      const replyMessage = choice.message;

      console.log(`[Tool loop] Round ${round} finish_reason=${finishReason}, tools=${replyMessage.tool_calls?.length || 0}`);

      // Always add Kimi's assistant message back to context (required by Moonshot docs)
      messages.push(replyMessage);

      if (finishReason === 'tool_calls' && replyMessage.tool_calls) {
        // Execute all tool calls and build role=tool messages
        for (const toolCall of replyMessage.tool_calls) {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);

          console.log(`[Tool] ${functionName}:`, args);

          let result = null;

          // Server-side calculation tools
          try {
            switch (functionName) {
              case 'calculateIOB':
                result = calculateIOB(args.doses, args.insulinDuration);
                break;
              case 'analyzeGlucoseTrend':
                result = analyzeGlucoseTrend(args.readings, args.currentIOB);
                break;
              case 'calculateWorkoutNutrition':
                result = calculateWorkoutNutrition(args);
                break;
              case 'calculateCorrectionDose':
                result = calculateCorrectionDose(args);
                break;
              case 'analyzeSleepImpact':
                result = analyzeSleepImpact(args);
                break;
              case 'predictHypoRisk':
                result = predictHypoRisk(args);
                break;
              case 'navigate':
                result = { success: true };
                allActions.push({ type: 'navigate', ...args });
                break;
              default:
                // Memory tools (logEvent, setPreference, addInsight, etc.)
                // Executed on-device — tell Kimi they succeeded so it can respond
                result = { success: true, message: `${functionName} queued for on-device execution` };
                allMemoryToolCalls.push({ id: toolCall.id, name: functionName, arguments: args });
                break;
            }
          } catch (e) {
            console.error(`[Tool] Error executing ${functionName}:`, e);
            result = { error: e.message };
          }

          if (['calculateIOB', 'analyzeGlucoseTrend', 'calculateWorkoutNutrition',
               'calculateCorrectionDose', 'analyzeSleepImpact', 'predictHypoRisk'].includes(functionName)) {
            allToolResults.push({ id: toolCall.id, name: functionName, arguments: args, result });
          }

          // Feed result back to Kimi as role=tool (required by Moonshot docs)
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: functionName,
            content: JSON.stringify(result)
          });
        }
      } else {
        // finish_reason=stop — Kimi has produced the final response
        replyText = replyMessage.content || replyMessage.reasoning_content || '';
      }
    }

    // Safety fallback if loop hit max rounds without a stop
    if (!replyText && round >= MAX_TOOL_ROUNDS) {
      replyText = 'Done. Let me know if you need anything else.';
    }

    console.log('Sending response to app:', {
      textLength: replyText.length,
      memoryToolCalls: allMemoryToolCalls.length,
      toolResults: allToolResults.length,
      actions: allActions.length,
      rounds: round
    });

    res.json({
      message: replyText,
      toolCalls: allMemoryToolCalls.length > 0 ? allMemoryToolCalls : undefined,
      toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      actions: allActions.length > 0 ? allActions : undefined,
      finishReason: finishReason
    });
    
  } catch (error) {
    console.error('Chat error:', error.message, error.stack);
    res.status(500).json({
      error: 'Internal error',
      detail: error.message,
      message: "Having trouble connecting. Try again in a moment. 🦈"
    });
  }
});

// ==========================================
// SUBSCRIPTION ENDPOINTS
// ==========================================

app.get('/v1/user/trial', requireAuth, (req, res) => {
  const userId = req.userId;
  
  if (!users.has(userId)) {
    return res.json({ isTrial: true, daysLeft: 2 });
  }
  
  const user = users.get(userId);
  const hoursSinceInstall = (Date.now() - user.installDate) / (1000 * 60 * 60);
  const isTrialActive = hoursSinceInstall < 48;
  
  res.json({
    isTrial: isTrialActive,
    hoursLeft: isTrialActive ? Math.max(0, 48 - hoursSinceInstall) : 0,
    isSubscribed: user.isSubscribed,
    messageCount: user.messageCount
  });
});

app.get('/v1/user/subscription', requireAuth, (req, res) => {
  const user = users.get(req.userId);
  res.json({
    isSubscribed: user?.isSubscribed || false,
    trialExpired: !user?.isSubscribed && (Date.now() - user?.installDate) > 48 * 60 * 60 * 1000
  });
});

// Validate receipt from Apple (server-side validation)
app.post('/v1/subscription/validate', requireAuth, async (req, res) => {
  try {
    const { receipt, productId, platform } = req.body;
    
    // For production: Validate with Apple's servers
    // For now: Accept and mark as subscribed
    const user = users.get(req.userId);
    if (user) {
      user.isSubscribed = true;
      saveUsers();
    }

    console.log(`[Subscription] Validated for ${req.userId}: ${productId}`);
    res.json({ success: true, status: 'active' });
  } catch (error) {
    console.error('[Subscription] Validation error:', error);
    res.status(500).json({ error: 'Validation failed' });
  }
});

// ==========================================
// EMERGENCY SMS (Twilio - server-side auto-send)
// ==========================================

// POST /v1/emergency/sms
// Called by the app when a critical low is detected and the user cannot confirm manually.
// Charges the SMS cost back to the user subscription via the sms_log table (app-side).
// Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID env vars on Railway.
app.post('/v1/emergency/sms', requireAuth, async (req, res) => {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_MESSAGING_SERVICE_SID) {
    return res.status(503).json({ error: 'SMS service not configured' });
  }

  const { toPhone, message, glucose } = req.body;
  if (!toPhone || !message) {
    return res.status(400).json({ error: 'toPhone and message are required' });
  }

  // Basic phone validation — must start with + and contain only digits after
  if (!/^\+\d{7,15}$/.test(toPhone)) {
    return res.status(400).json({ error: 'toPhone must be in E.164 format, e.g. +15551234567' });
  }

  try {
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const body = new URLSearchParams({
      To: toPhone,
      MessagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
      Body: message,
    });

    const response = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
      },
      body: body.toString(),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[SMS] Twilio error:', data);
      return res.status(502).json({ error: 'SMS delivery failed', detail: data.message });
    }

    console.log(`[SMS] Sent to ${toPhone} for user ${req.userId}, glucose=${glucose}, sid=${data.sid}`);
    res.json({ success: true, sid: data.sid });
  } catch (error) {
    console.error('[SMS] Error:', error.message);
    res.status(500).json({ error: 'Internal error sending SMS' });
  }
});

// ==========================================
// MEMORY DEBUG (stateless - returns empty)
// ==========================================

app.get('/v1/vicente/memory', requireAuth, (req, res) => {
  res.json({ 
    note: 'Memory is stored locally in the app via SQLite',
    toolCallsSupported: true,
    sections: ['USER', 'MEMORY', 'events', 'insights', 'preferences']
  });
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🦈 Server running on port ${PORT}`);
  console.log('✅ Native tool_calls enabled');
  console.log('Tools:', VICENTE_TOOLS.map(t => t.function.name).join(', '));
});
