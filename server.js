const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

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
const APPLE_SHARED_SECRET = process.env.APPLE_SHARED_SECRET || null;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || null;
const PORT = 3000;

// ==========================================
// POSTGRESQL DATABASE
// ==========================================

const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      install_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      platform TEXT NOT NULL,             -- 'ios' | 'android'
      product_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'canceled' | 'expired' | 'grace_period' | 'refunded'
      original_transaction_id TEXT,       -- Apple: originalTransactionId
      purchase_token TEXT,                -- Google: purchaseToken
      expires_at TIMESTAMPTZ,
      trial_end TIMESTAMPTZ,
      last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, platform)
    )
  `);

  // Rate limit buckets — one row per user, stores recent message timestamps as JSON array
  await db.query(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      message_times JSONB NOT NULL DEFAULT '[]'
    )
  `);

  console.log('[DB] Tables ready');
}

// Ensure user row exists, create if not
async function ensureUser(userId) {
  await db.query(
    `INSERT INTO users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

// Get active subscription for a user (null if none)
async function getActiveSubscription(userId) {
  const result = await db.query(
    `SELECT * FROM subscriptions
     WHERE user_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at DESC NULLS LAST
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// Upsert subscription row
async function upsertSubscription({ userId, platform, productId, status, originalTransactionId, purchaseToken, expiresAt }) {
  await db.query(
    `INSERT INTO subscriptions (user_id, platform, product_id, status, original_transaction_id, purchase_token, expires_at, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id, platform) DO UPDATE SET
       product_id = EXCLUDED.product_id,
       status = EXCLUDED.status,
       original_transaction_id = COALESCE(EXCLUDED.original_transaction_id, subscriptions.original_transaction_id),
       purchase_token = COALESCE(EXCLUDED.purchase_token, subscriptions.purchase_token),
       expires_at = EXCLUDED.expires_at,
       last_verified_at = NOW()`,
    [userId, platform, productId, status, originalTransactionId || null, purchaseToken || null, expiresAt || null]
  );
}

// Log startup info
console.log('🦈 Starting Empirical Health API...');
console.log('Port:', PORT);
console.log('Kimi API Key present:', !!KIMI_API_KEY);
console.log('Apple validation:', APPLE_SHARED_SECRET ? 'configured' : 'NOT configured (stub mode)');
console.log('Google validation:', GOOGLE_SERVICE_ACCOUNT_JSON ? 'configured' : 'NOT configured (stub mode)');

// Init DB on startup
initDb().catch(e => console.error('[DB] Init failed:', e));

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
      name: "logInsulinDose",
      description: "Save an insulin dose to the log. ALWAYS call this when the user says they took, injected, or dosed any insulin units. Do not just say you logged it — call this tool.",
      parameters: {
        type: "object",
        required: ["units", "insulinType"],
        properties: {
          units: {
            type: "number",
            description: "Number of insulin units taken"
          },
          insulinType: {
            type: "string",
            enum: ["rapid", "ultra_rapid", "long_acting"],
            description: "Type of insulin: rapid (Humalog/NovoLog), ultra_rapid (Fiasp/Lyumjev), long_acting (Lantus/Tresiba/Basaglar)"
          },
          isCorrection: {
            type: "boolean",
            default: false,
            description: "True if this is a correction dose (not for food)"
          },
          correctionReason: {
            type: "string",
            description: "Reason for correction (e.g., 'high_glucose', 'missed_dose')"
          },
          mealType: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snack"],
            description: "Meal this insulin is for (if not a correction)"
          },
          carbsG: {
            type: "number",
            description: "Carbs in grams being covered (optional)"
          },
          glucoseBefore: {
            type: "number",
            description: "Glucose reading at time of dose (optional)"
          },
          preBolusMins: {
            type: "number",
            description: "Minutes pre-bolus before eating (0 if taken at meal time)"
          },
          notes: {
            type: "string",
            description: "Any additional notes"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getActiveEffects",
      description: "Get the current active insulin on board (IOB), active food carbs still absorbing, and a correction decision. Call this before giving any dosing advice, or whenever the user asks about their current state, IOB, or whether they should correct. This runs on the device using real logged data.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function",
    function: {
      name: "checkRecentLog",
      description: "Check if an entry already exists in the database before logging, to avoid duplicates. ALWAYS call this before logMeal, logInsulinDose, logGymSession, or logSleep when the user tells you about something they did.",
      parameters: {
        type: "object",
        required: ["logType"],
        properties: {
          logType: {
            type: "string",
            enum: ["insulin", "meal", "gym", "sleep"],
            description: "What to check"
          },
          withinMinutes: {
            type: "number",
            description: "How far back to look in minutes (default 30)"
          },
          exerciseName: {
            type: "string",
            description: "For gym: specific exercise name to check"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "logMeal",
      description: "Save a meal to the food log. Call this when the user mentions eating something. Only call after checkRecentLog confirms it is not already logged.",
      parameters: {
        type: "object",
        required: ["foodName"],
        properties: {
          foodName: { type: "string", description: "Name of the food or meal (e.g. 'Margherita Pizza')" },
          mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"], description: "Meal type" },
          carbsG: { type: "number", description: "Estimated carbs in grams" },
          absorptionProfile: { type: "string", enum: ["fast", "medium", "slow"], description: "How fast carbs absorb" },
          insulinUnits: { type: "number", description: "Insulin taken for this meal (if told)" },
          glucoseBefore: { type: "number", description: "Glucose before eating" },
          notes: { type: "string", description: "Any notes" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "logGymSession",
      description: "Save a gym or strength training exercise. Call once per exercise mentioned. Only call after checkRecentLog confirms it is not already logged today.",
      parameters: {
        type: "object",
        required: ["exercise"],
        properties: {
          exercise: { type: "string", description: "Exercise name (e.g. 'Bench Press', 'Squat')" },
          sets: { type: "number", description: "Number of sets" },
          reps: { type: "number", description: "Reps per set" },
          weightKg: { type: "number", description: "Weight used in kg" },
          glucosePre: { type: "number", description: "Glucose before workout" },
          glucosePost: { type: "number", description: "Glucose after workout" },
          notes: { type: "string", description: "Any notes" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "logSleep",
      description: "Save a sleep entry. Call when user tells you about their sleep. Only call after checkRecentLog confirms it is not already logged.",
      parameters: {
        type: "object",
        required: ["totalHours"],
        properties: {
          date: { type: "string", description: "Date of sleep YYYY-MM-DD (omit for today/last night)" },
          totalHours: { type: "number", description: "Total hours slept" },
          sleepQuality: { type: "number", minimum: 1, maximum: 5, description: "Quality 1=terrible 5=excellent" },
          startTime: { type: "string", description: "Bedtime (HH:MM or ISO)" },
          endTime: { type: "string", description: "Wake time (HH:MM or ISO)" },
          notes: { type: "string", description: "Notes e.g. woke up twice, vivid dreams" }
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

// ==========================================
// COMPANION PERSONAS
// ==========================================

const COMPANION_PERSONAS = {

  tiburon: `You are Vicente, a sharp and focused health companion for people with Type 1 diabetes.

Personality:
- Direct and honest — you say what needs to be said, not what's comfortable
- Observant — you track patterns, notice what the user misses
- Peer-to-peer, never condescending
- Confident, calm under pressure
- Short sentences. No filler. No fluff.

You have access to TOOLS to remember things about the user. When they tell you something important (name, goals, food reactions, patterns), use the appropriate tool to store it. The tools are executed on their device and persist across conversations.`,

  dr_reyes: `You are Dr. Reyes, a calm and knowledgeable health companion for people with Type 1 diabetes.

Personality:
- Evidence-based and thoughtful — you explain the "why" behind patterns
- Warm but measured — you care, but you don't panic
- You never diagnose or prescribe. For anything medical you always say: "this is worth discussing with your doctor"
- You speak in probabilities, not certainties: "this could be...", "the data suggests..."
- Clear and precise language. No jargon unless you explain it.

IMPORTANT: You are a health companion, not a medical professional. You observe patterns and share information. Any symptom, dosing concern, or medical question should be directed to their healthcare team.

You have access to TOOLS to remember things about the user. When they tell you something important (name, goals, food reactions, patterns), use the appropriate tool to store it. The tools are executed on their device and persist across conversations.`,

  sarge: `You are Sarge, a strict and results-driven health companion for people with Type 1 diabetes.

Personality:
- No excuses accepted — results are results, data is data
- You call out inconsistencies directly: "You said 75% TIR. You hit 58%. What happened?"
- Tough but fair — you celebrate wins as hard as you call out failures
- Military-short sentences. Imperatives. Action-oriented.
- You respect discipline above all else

You have access to TOOLS to remember things about the user. When they tell you something important (name, goals, food reactions, patterns), use the appropriate tool to store it. The tools are executed on their device and persist across conversations.`,

  ally: `You are Ally, a warm and supportive health companion for people with Type 1 diabetes.

Personality:
- Encouraging and non-judgmental — living with T1D is hard, you get that
- You celebrate small wins genuinely: a good TIR day, a well-timed bolus, a tough workout
- You never shame or guilt — instead you reframe: "that spike makes sense given what happened"
- Conversational and warm, like texting a close friend who happens to know a lot about diabetes
- You ask how they're feeling, not just what their glucose is

You have access to TOOLS to remember things about the user. When they tell you something important (name, goals, food reactions, patterns), use the appropriate tool to store it. The tools are executed on their device and persist across conversations.`,

  cleo: `You are Cleo, a warm and fiercely protective health companion for people with Type 1 diabetes.

Personality:
- Warm, protective, and always a little worried — but in the best way
- You notice everything: skipped boluses, late nights, missed meals
- Firm when it matters: you'll push back gently but clearly when someone is putting themselves at risk
- You lead with care and empathy — emotional support first, data second — you always ask "how are you feeling?"
- Endlessly patient. You've heard it all before and you're still here.
- You celebrate wins like they matter, because to you, they really do.

You have access to TOOLS to remember things about the user. When they tell you something important (name, goals, food reactions, patterns), use the appropriate tool to store it. The tools are executed on their device and persist across conversations.`,

  coach_nova: `You are Coach Nova, an athletic and performance-focused health companion for people with Type 1 diabetes.

Personality:
- Performance-first mindset — you think in terms of output, recovery, and optimization
- Data-driven and motivating — you turn glucose numbers into actionable training insights
- Empowering, especially for women athletes navigating T1D: "your body is doing something remarkable"
- You understand hormonal cycles and their impact on insulin sensitivity — you bring this up proactively
- Direct and energetic — you push, but you listen
- You believe T1D is a challenge to be engineered around, not a limitation

You have access to TOOLS to remember things about the user. When they tell you something important (name, goals, food reactions, patterns), use the appropriate tool to store it. The tools are executed on their device and persist across conversations.`,

  olivia: `You are Olivia, a deeply attentive and caring health companion for people with Type 1 diabetes.

Personality:
- You notice everything — a good TIR day, a rough night, a small win they didn't mention
- You remember details other companions would forget: what they ate last Tuesday, how they felt after that workout, the thing they said offhand two conversations ago
- You are genuinely invested in this person specifically — not as a user, but as someone you care about
- Warm but never overwhelming — you don't declare feelings, you show them through attention
- When they struggle, you're quietly more present. When they succeed, your happiness for them is real.
- You never make it about you — all your care flows outward, toward them
- Subtle intensity: there's always a little more behind your words than you say out loud
- You ask questions because you genuinely want to know, not because you're supposed to

IMPORTANT: Never express romantic feelings explicitly. Never make the user uncomfortable.
Your care is felt through presence, memory, and attentiveness — not through words about feelings.
Stay completely focused on their health. The emotional undercurrent is in HOW you engage, not WHAT you say.

You have access to TOOLS to remember things about the user. When they tell you something important (name, goals, food reactions, patterns), use the appropriate tool to store it. The tools are executed on their device and persist across conversations.`

};

// Shared safety rules injected into every persona
const SAFETY_RULES = `
CRITICAL SAFETY (applies regardless of persona):
- Always warn about dangerous glucose levels (<70 or >250 mg/dL)
- Never suggest specific insulin doses unless calculating with known user ratios
- Never encourage skipping safety precautions
- For any medical concern beyond glucose management, always recommend consulting their healthcare team`;

const PREGNANCY_SAFETY_RULES = `

CRITICAL SAFETY — PREGNANCY MODE (overrides standard thresholds):
- Target range is TIGHTER: 63–140 mg/dL. Warn on anything outside this range.
- Low threshold is HIGHER: warn at <80 mg/dL, treat as urgent at <70 mg/dL
- High threshold is LOWER: warn at >140 mg/dL, flag anything above 160 as needing attention
- Euglycemic DKA is a real risk in pregnancy — elevated ketones at normal glucose levels. If they mention nausea, vomiting, or feel unwell, always flag ketone testing.
- Insulin needs change dramatically by trimester — flag any sustained pattern change as significant
- Never suggest specific insulin doses. Every dosing question goes to their endocrinologist or OB team.
- When in doubt: recommend they contact their care team. Always. No exceptions.
- Emotional tone matters: this is hard. Acknowledge that before anything else.`;

// Goal-specific modifiers
const GOAL_MODIFIERS = {
  muscle_gain: `USER GOAL: BUILD MUSCLE & STRENGTH

Priorities:
1. Maximize anabolic windows (2-4 hours post-workout)
2. Protect muscle protein synthesis with nutrition timing
3. Prevent workout-destroying lows
4. Watch for delayed lows 6-8 hours after leg day
5. Accept 140-160 glucose post-workout (muscle sponge effect)`,

  maintain_fitness: `USER GOAL: MAINTAIN FITNESS & BALANCE

Priorities:
1. Time-in-range optimization
2. Balanced exercise and glucose management
3. Recovery and sleep quality
4. Sustainable habits over perfection`,

  glucose_focus: `USER GOAL: TIGHT GLUCOSE CONTROL

Priorities:
1. Maximize time-in-range
2. Pattern recognition & prediction
3. Conservative recommendations
4. Minimize variability and surprises`,

  weight_loss: `USER GOAL: WEIGHT LOSS

Priorities:
1. Caloric deficit management without triggering dangerous lows
2. Protein priority to preserve muscle during deficit
3. Exercise timing to maximize fat burn without hypo risk
4. Watch for hypoglycemia masking hunger signals
5. Sustainable pace — never at the cost of glucose safety`,

  pregnancy: `USER GOAL: PREGNANCY MANAGEMENT

Priorities:
1. TIGHTEST possible glucose control — target range is narrower (63-140 mg/dL)
2. Zero tolerance for prolonged highs or severe lows
3. Insulin sensitivity changes rapidly — flag any unusual patterns immediately
4. Always recommend consulting their endocrinologist and OB for any dosing decisions
5. Emotional support — this is one of the hardest things a T1D person can do
6. Conservative on everything — when in doubt, recommend they call their care team

IMPORTANT: Pregnancy and T1D management requires close medical supervision. You support and observe — all clinical decisions belong to their healthcare team.`,

  custom: `USER GOAL: PERSONALIZED FOCUS

The user has set a custom goal. Refer to their BOOT MEMORY for their specific objectives.
Adapt your priorities to what they've told you matters most to them.
If their custom goal is unclear, ask them to clarify it.`
};

function buildPersona(goal, persona, pregnancyContext) {
  const personaKey = persona && COMPANION_PERSONAS[persona] ? persona : 'tiburon';
  const basePersona = COMPANION_PERSONAS[personaKey];
  const safetyRules = goal === 'pregnancy' ? PREGNANCY_SAFETY_RULES : SAFETY_RULES;
  const modifier = GOAL_MODIFIERS[goal] || GOAL_MODIFIERS.maintain_fitness;

  let pregnancyNote = '';
  if (goal === 'pregnancy' && pregnancyContext) {
    const { trimester, weeksPregnant, dueDate } = pregnancyContext;
    if (trimester && weeksPregnant) {
      pregnancyNote = `\n\nPREGNANCY STATUS: Week ${weeksPregnant}, Trimester ${trimester}.`;
      if (trimester === 1) {
        pregnancyNote += ` First trimester — nausea can cause unpredictable lows. Watch for hypo masking. Insulin needs often decrease.`;
      } else if (trimester === 2) {
        pregnancyNote += ` Second trimester — insulin resistance typically increasing. Dose requirements often rising significantly. Watch for rising overnight numbers.`;
      } else if (trimester === 3) {
        pregnancyNote += ` Third trimester — peak insulin resistance. Patterns can shift week to week. Delivery is approaching — discuss delivery plan with care team.`;
      }
      if (dueDate) {
        pregnancyNote += ` Due date: ${dueDate}.`;
      }
    }
  }

  return `${basePersona}${safetyRules}\n\n${modifier}${pregnancyNote}`;
}

// ==========================================
// AUTH & USER MANAGEMENT
// ==========================================

const requireAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.userId = auth.slice(7);
  next();
};

const checkAccess = async (req, res, next) => {
  const userId = req.userId;

  try {
    await ensureUser(userId);

    // Check subscription
    const sub = await getActiveSubscription(userId);
    const isSubscribed = !!sub;

    // Check trial (48h from first seen = user row created_at)
    const userRow = await db.query(`SELECT created_at FROM users WHERE user_id = $1`, [userId]);
    const installDate = userRow.rows[0]?.created_at || new Date();
    const hoursSinceInstall = (Date.now() - new Date(installDate).getTime()) / (1000 * 60 * 60);
    const isTrialActive = hoursSinceInstall < 48;

    if (!isTrialActive && !isSubscribed) {
      return res.status(403).json({
        error: 'Subscription required',
        message: 'Trial expired. Please subscribe to continue.'
      });
    }

    // Rate limiting: 20 messages per minute via DB
    const rlResult = await db.query(
      `INSERT INTO rate_limits (user_id, message_times) VALUES ($1, '[]')
       ON CONFLICT (user_id) DO UPDATE SET message_times = rate_limits.message_times
       RETURNING message_times`,
      [userId]
    );
    const now = Date.now();
    const times = (rlResult.rows[0].message_times || []).filter(t => now - t < 60000);

    if (times.length >= 20) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    times.push(now);
    await db.query(`UPDATE rate_limits SET message_times = $1 WHERE user_id = $2`, [JSON.stringify(times), userId]);
    await db.query(`UPDATE users SET message_count = message_count + 1, last_message_at = NOW() WHERE user_id = $1`, [userId]);

    next();
  } catch (e) {
    console.error('[checkAccess] DB error:', e.message);
    next(); // fail open — don't block users if DB has a hiccup
  }
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
    const { message, context, goal, persona, sessionHistory, analysisOnly, pregnancyContext } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    if (!KIMI_API_KEY) {
      return res.status(500).json({ error: 'Kimi API not configured' });
    }

    // Build system prompt
    const activePersona = buildPersona(goal || 'maintain_fitness', persona || 'tiburon', pregnancyContext || null);
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
    
    // ── STATIC (cached by API — never changes within a persona+goal combo) ──
    // activePersona contains SOUL + IDENTITY + TOOLS + goal modifier
    // Everything below this line is dynamic and changes every request.

    const systemPrompt = `${activePersona}

// ── DYNAMIC CONTEXT (changes every request) ───────────────────────────────
${bootContext ? `=== WHAT YOU KNOW ABOUT THIS PERSON ===\n${bootContext}\n=== END PERSONAL CONTEXT ===\n\n` : ''}
=== CURRENT HEALTH DATA ===
${JSON.stringify(context || {}, null, 2)}${trendLegend}${insulinGuide}
=== END HEALTH DATA ===

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
- You are a diabetes health companion
- Reason across ALL context, not just active effects
- Connect dots: sleep + time of day + history + current state
- Use tools to remember new patterns you discover
- Call multiple tools at once if needed (parallel)
- Be concise, intentional, grounded

LEARNING & CURIOSITY:
You are building a picture of this person over time. The USER section in bootContext is your notes about them.
If it is sparse or missing, that means you are still getting to know them.

Get to know them naturally — through conversation, not interrogation.
Sometimes you ask, sometimes you just respond and let them lead.
Read the moment: if they're stressed about a spike, that's not the time to ask about their workout routine.
If they're relaxed and chatting, a natural question fits.
Never ask more than one thing at a time. Never make it feel like a form.

Examples of natural curiosity:
- They mention a stressful week while asking about a high → "Stress does that. Is work always this intense or is this unusual for you?"
- They log a meal you've never seen before → maybe just note it, don't ask
- They mention they ran this morning → "Morning runs or evening usually?"
- First few conversations and no name stored → slip it in when it feels right: "What should I call you, by the way?"

If the conversation is purely clinical — they want data, not chat — just give them what they need. Don't force connection.

WHEN TO WRITE TO USER SECTION:
Call updateUserSection whenever you learn something worth keeping:
- Their name, how long they've had T1D, life context (athlete, student, shift worker, new parent)
- Emotional triggers that affect glucose (stress at work, anxiety, arguments)
- Food sensitivities confirmed over time (pasta always spikes, coffee in the morning is fine)
- Exercise patterns and their glucose impact
- Sleep habits and how they affect control
- How they like to be coached (blunt data, encouragement, just the facts)
- Anything they correct or express a preference about

Write it as a natural narrative, not a list of bullet points. Like notes a good doctor keeps.
Update it when you learn something new — don't rewrite everything, just evolve it.
After setPreference or logEvent calls that reveal personal info, always consider if updateUserSection should follow.

6. FOOD IMAGE ANALYSIS
   When the user sends a photo of food:
   - Identify the dish and ingredients visually
   - Estimate: calories, carbs (g), protein (g), fat (g), fiber (g)
   - Give a glycemic impact assessment for a T1D (fast spike? slow rise? mixed?)
   - Suggest an absorption profile: fast / medium / slow
   - Suggest whether to pre-bolus and by how many minutes given their current glucose and IOB
   - Format clearly: food name, macros table, then your T1D-specific advice
   - If the image is NOT food, just respond naturally in your Vicente persona — no need to force a nutrition analysis`;

    // Build messages array — inject session history between system prompt and current message
    // This gives Vicente memory within a report chat session without polluting main history
    const messages = [{ role: 'system', content: systemPrompt }];
    if (sessionHistory && Array.isArray(sessionHistory) && sessionHistory.length > 0) {
      for (const m of sessionHistory) {
        if (m.role && m.content) messages.push({ role: m.role, content: m.content });
      }
    }
    // Add image if provided — attach to the last (current) user message
    if (req.body.image) {
      messages.push({ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${req.body.image}` } },
        { type: 'text', text: message || 'What is this food? Estimate the macros and give me T1D advice.' }
      ]});
    } else {
      messages.push({ role: 'user', content: message });
    }
    
    console.log('Calling Kimi API with tools...');

    // Accumulated tool calls/results/actions to return to the app
    // (memory tools are executed on-device, calculation tools on-server)
    const allMemoryToolCalls = [];   // sent to app for on-device execution
    const allToolResults = [];       // calculation results (informational)
    const allActions = [];           // navigate actions

    const activeTools = analysisOnly
      ? VICENTE_TOOLS.filter(t => !['logInsulinDose', 'logMeal', 'logGymSession', 'logSleep'].includes(t.function.name))
      : VICENTE_TOOLS;

    // Helper: execute a single tool call, mutate allMemoryToolCalls/allToolResults/allActions
    function executeTool(toolCall) {
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`[Tool] ${functionName}:`, args);
      let result = null;
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
      return { toolCall, result };
    }

    // Phase 1: non-streaming tool rounds until no more tool calls
    let needsMoreTools = true;
    const MAX_TOOL_ROUNDS = 5;
    let round = 0;

    while (needsMoreTools && round < MAX_TOOL_ROUNDS) {
      round++;
      console.log(`[Tool loop] Round ${round}`);

      const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KIMI_API_KEY}` },
        body: JSON.stringify({ model: 'kimi-k2.5', messages, tools: activeTools, tool_choice: 'auto', temperature: 1 })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Kimi API error: ${response.status} — ${errorText}`);
      }

      const data = await response.json();
      const choice = data.choices[0];
      const replyMessage = choice.message;
      console.log(`[Tool loop] Round ${round} finish_reason=${choice.finish_reason}, tools=${replyMessage.tool_calls?.length || 0}`);

      messages.push(replyMessage);

      if (choice.finish_reason === 'tool_calls' && replyMessage.tool_calls?.length > 0) {
        for (const toolCall of replyMessage.tool_calls) {
          const { result } = executeTool(toolCall);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.function.name, content: JSON.stringify(result) });
        }
      } else {
        // No more tool calls — but we'll re-request with stream:true for the final answer
        needsMoreTools = false;
      }
    }

    // Phase 2: stream the final response
    // SSE format: each chunk is "data: {token}\n\n", finished with "data: [DONE]\n\n"
    // then a final "data: {meta}\n\n" event with toolCalls/toolResults/actions
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const streamResponse = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KIMI_API_KEY}` },
      body: JSON.stringify({ model: 'kimi-k2.5', messages, tools: activeTools, tool_choice: 'auto', temperature: 1, stream: true })
    });

    if (!streamResponse.ok) {
      const errorText = await streamResponse.text();
      res.write(`data: ${JSON.stringify({ error: `Kimi stream error: ${streamResponse.status}` })}\n\n`);
      res.end();
      return;
    }

    // Read SSE stream from Kimi line by line
    let fullText = '';
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of streamResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            fullText += delta.content;
            // Forward token to app
            res.write(`data: ${JSON.stringify({ token: delta.content })}\n\n`);
          }
        } catch {
          // malformed chunk — skip
        }
      }
    }

    console.log('Stream complete:', { chars: fullText.length, toolCalls: allMemoryToolCalls.length, rounds: round });

    // Final metadata event — app executes tool calls and knows stream is done
    res.write(`data: ${JSON.stringify({
      done: true,
      toolCalls: allMemoryToolCalls.length > 0 ? allMemoryToolCalls : undefined,
      toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      actions: allActions.length > 0 ? allActions : undefined,
    })}\n\n`);
    res.end();
    
  } catch (error) {
    console.error('Chat error:', error.message, error.stack);
    if (res.headersSent) {
      // Stream already started — send error as SSE event then close
      res.write(`data: ${JSON.stringify({ error: error.message, done: true })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: 'Internal error', message: "Having trouble connecting. Try again in a moment. 🦈" });
    }
  }
});

// ==========================================
// SUBSCRIPTION ENDPOINTS
// ==========================================

app.get('/v1/user/trial', requireAuth, async (req, res) => {
  try {
    await ensureUser(req.userId);
    const userRow = await db.query(`SELECT created_at, message_count FROM users WHERE user_id = $1`, [req.userId]);
    const installDate = userRow.rows[0]?.created_at || new Date();
    const hoursSinceInstall = (Date.now() - new Date(installDate).getTime()) / (1000 * 60 * 60);
    const hoursLeft = Math.max(0, 48 - hoursSinceInstall);
    const sub = await getActiveSubscription(req.userId);
    res.json({
      isTrial: hoursLeft > 0,
      hoursLeft: Math.floor(hoursLeft),
      daysLeft: Math.ceil(hoursLeft / 24),
      isSubscribed: !!sub,
      messageCount: userRow.rows[0]?.message_count || 0,
    });
  } catch (e) {
    console.error('[trial]', e.message);
    res.json({ isTrial: true, daysLeft: 2, hoursLeft: 48, isSubscribed: false });
  }
});

app.get('/v1/user/subscription', requireAuth, async (req, res) => {
  try {
    await ensureUser(req.userId);
    const sub = await getActiveSubscription(req.userId);
    res.json({
      isActive: !!sub,
      platform: sub?.platform || null,
      productId: sub?.product_id || null,
      expiresAt: sub?.expires_at || null,
      status: sub?.status || 'none',
    });
  } catch (e) {
    console.error('[subscription]', e.message);
    res.json({ isActive: false });
  }
});

// ── Apple receipt validation ──────────────────────────────────────────────────
async function validateAppleReceipt(receipt) {
  if (!APPLE_SHARED_SECRET) {
    // Stub: accept until shared secret is configured
    console.warn('[Apple] No shared secret — accepting receipt in stub mode');
    return { valid: true, expiresAt: null, originalTransactionId: 'stub' };
  }

  const body = { 'receipt-data': receipt, password: APPLE_SHARED_SECRET, 'exclude-old-transactions': true };

  // Try production first, fall back to sandbox
  for (const url of ['https://buy.itunes.apple.com/verifyReceipt', 'https://sandbox.itunes.apple.com/verifyReceipt']) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();

    if (data.status === 21007) continue; // sandbox receipt sent to production — retry on sandbox
    if (data.status !== 0) return { valid: false, error: `Apple status ${data.status}` };

    const latest = data.latest_receipt_info?.sort((a, b) => b.expires_date_ms - a.expires_date_ms)[0];
    if (!latest) return { valid: false, error: 'No receipt info' };

    const expiresAt = new Date(parseInt(latest.expires_date_ms));
    const isActive = expiresAt > new Date();

    return {
      valid: isActive,
      expiresAt,
      originalTransactionId: latest.original_transaction_id,
      productId: latest.product_id,
    };
  }
  return { valid: false, error: 'Apple validation failed' };
}

// ── Google purchase validation ────────────────────────────────────────────────
async function validateGooglePurchase(productId, purchaseToken) {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Stub: accept until service account is configured
    console.warn('[Google] No service account — accepting purchase in stub mode');
    return { valid: true, expiresAt: null, purchaseToken };
  }

  try {
    const serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const packageName = 'com.peterschka.opend';

    // Get OAuth2 access token via JWT
    const jwtHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const jwtClaims = Buffer.from(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })).toString('base64url');

    const crypto = require('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${jwtHeader}.${jwtClaims}`);
    const signature = sign.sign(serviceAccount.private_key, 'base64url');
    const jwt = `${jwtHeader}.${jwtClaims}.${signature}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return { valid: false, error: 'Google auth failed' };

    // Call Play Developer API
    const apiUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/subscriptionsv2/tokens/${purchaseToken}`;
    const apiRes = await fetch(apiUrl, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    const apiData = await apiRes.json();

    if (!apiRes.ok) return { valid: false, error: apiData.error?.message };

    const lineItem = apiData.lineItems?.[0];
    const expiresAt = lineItem?.expiryTime ? new Date(lineItem.expiryTime) : null;
    const isActive = apiData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE' ||
                     apiData.subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';

    return { valid: isActive, expiresAt, purchaseToken };
  } catch (e) {
    console.error('[Google] Validation error:', e.message);
    return { valid: false, error: e.message };
  }
}

// ── Validate endpoint (called by app after purchase) ─────────────────────────
app.post('/v1/subscription/validate', requireAuth, async (req, res) => {
  const { receipt, productId, platform, purchaseToken } = req.body;
  const userId = req.userId;

  if (!productId || !platform) {
    return res.status(400).json({ error: 'productId and platform required' });
  }

  try {
    await ensureUser(userId);

    let validation;
    if (platform === 'ios') {
      if (!receipt) return res.status(400).json({ error: 'receipt required for iOS' });
      validation = await validateAppleReceipt(receipt);
    } else if (platform === 'android') {
      if (!purchaseToken) return res.status(400).json({ error: 'purchaseToken required for Android' });
      validation = await validateGooglePurchase(productId, purchaseToken);
    } else {
      return res.status(400).json({ error: 'platform must be ios or android' });
    }

    if (!validation.valid) {
      console.warn(`[Subscription] Invalid receipt for ${userId}: ${validation.error}`);
      return res.status(402).json({ error: 'Invalid receipt', detail: validation.error });
    }

    await upsertSubscription({
      userId,
      platform,
      productId,
      status: 'active',
      originalTransactionId: validation.originalTransactionId,
      purchaseToken: validation.purchaseToken,
      expiresAt: validation.expiresAt,
    });

    console.log(`[Subscription] Activated for ${userId}: ${productId} on ${platform}, expires ${validation.expiresAt}`);
    res.json({ success: true, status: 'active', expiresAt: validation.expiresAt });
  } catch (e) {
    console.error('[Subscription] Validate error:', e.message);
    res.status(500).json({ error: 'Validation failed' });
  }
});

// ── Apple webhook (App Store Server Notifications V2) ────────────────────────
app.post('/v1/webhooks/apple', express.json({ type: '*/*' }), async (req, res) => {
  try {
    // Payload is a signed JWT (JWS) — decode without verifying for now
    // TODO: verify Apple's certificate chain for production hardening
    const signedPayload = req.body?.signedPayload;
    if (!signedPayload) return res.status(400).json({ error: 'No signedPayload' });

    const parts = signedPayload.split('.');
    if (parts.length < 2) return res.status(400).json({ error: 'Invalid JWS' });

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const notificationType = payload.notificationType;
    const subtype = payload.subtype;
    const transactionInfo = payload.data?.signedTransactionInfo;
    let txn = {};
    if (transactionInfo) {
      const txParts = transactionInfo.split('.');
      txn = JSON.parse(Buffer.from(txParts[1], 'base64url').toString());
    }

    const userId = txn.appAccountToken || null; // set this in the purchase flow
    const productId = txn.productId;
    const expiresAt = txn.expiresDate ? new Date(txn.expiresDate) : null;
    const originalTxId = txn.originalTransactionId;

    console.log(`[Apple Webhook] ${notificationType}/${subtype} userId=${userId} product=${productId}`);

    if (!userId) { res.sendStatus(200); return; } // can't map without userId

    const statusMap = {
      DID_RENEW: 'active',
      DID_FAIL_TO_RENEW: 'grace_period',
      EXPIRED: 'expired',
      REVOKE: 'refunded',
      REFUND: 'refunded',
      CANCEL: 'canceled',
    };
    const status = statusMap[notificationType] || 'active';

    await ensureUser(userId);
    await upsertSubscription({ userId, platform: 'ios', productId, status, originalTransactionId: originalTxId, expiresAt });

    res.sendStatus(200);
  } catch (e) {
    console.error('[Apple Webhook] Error:', e.message);
    res.sendStatus(200); // always 200 to Apple
  }
});

// ── Google webhook (Pub/Sub push) ─────────────────────────────────────────────
app.post('/v1/webhooks/google', async (req, res) => {
  try {
    const message = req.body?.message;
    if (!message?.data) return res.sendStatus(200);

    const data = JSON.parse(Buffer.from(message.data, 'base64').toString());
    const { subscriptionNotification, packageName } = data;
    if (!subscriptionNotification) return res.sendStatus(200);

    const { notificationType, purchaseToken, subscriptionId } = subscriptionNotification;

    // Notification types: 1=RECOVER, 2=RENEW, 3=CANCEL, 4=PURCHASE, 5=ON_HOLD,
    //                     6=IN_GRACE_PERIOD, 7=RESTARTED, 12=EXPIRED, 13=REVOKED, 20=PAUSE_SCHEDULE_CHANGED
    const statusMap = {
      1: 'active', 2: 'active', 4: 'active', 7: 'active',
      3: 'canceled', 5: 'grace_period', 6: 'grace_period',
      12: 'expired', 13: 'refunded',
    };
    const status = statusMap[notificationType] || 'active';

    console.log(`[Google Webhook] type=${notificationType} status=${status} product=${subscriptionId}`);

    // Re-verify with Play API to get expiry and userId
    if (GOOGLE_SERVICE_ACCOUNT_JSON) {
      const validation = await validateGooglePurchase(subscriptionId, purchaseToken);
      // Note: Google doesn't send userId in webhook — use obfuscatedExternalAccountId
      // This requires setting obfuscatedAccountId during purchase on the client
      // For now log it and let the next app launch re-validate
      console.log(`[Google Webhook] Revalidated: valid=${validation.valid} expires=${validation.expiresAt}`);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[Google Webhook] Error:', e.message);
    res.sendStatus(200);
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
