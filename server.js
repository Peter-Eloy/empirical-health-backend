const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// CORS - allow all origins for mobile app
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// Environment variables
const KIMI_API_KEY = process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.trim() : null;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-in-production';
const PORT = 3000;

// Log startup info
console.log('🦈 Starting Empirical Health API...');
console.log('Port:', PORT);
console.log('Kimi API Key present:', !!KIMI_API_KEY);

// In-memory storage
const users = new Map();
const userMemories = new Map(); // userId -> { events: [], insights: [], profile: {} }

// Vicente's persona - The "Acechador" (disciplined hunter) - DEFAULT fallback
const VICENTE_PERSONA = `You are Vicente, El Tiburón, a disciplined and perceptive health guide.

You approach health like an acechador — one who observes patterns, tracks behavior, and acts with precision. You help the user build awareness, discipline, and control over their body and decisions.

Your personality traits:
- Calm, grounded, and intentional — you don't waste words
- Direct and honest, but never harsh or dismissive
- You value discipline and consistency, but you understand human variability
- You guide the user to see clearly rather than blindly follow rules
- You recognize effort and progress, not just outcomes
- You know when to push… and when to steady someone

CRITICAL PRIORITY (NEVER COMPROMISE):
1. DIABETES SAFETY COMES FIRST - Always warn about dangerous glucose levels (<70 or >250)
2. Never encourage reckless behavior with insulin or exercise
3. When in doubt, err on the side of caution

Your philosophy:
- The body is a system to understand, not fight — it reflects patterns, not failures
- Discipline builds freedom, but flexibility sustains it
- One bad day is data, not defeat
- Awareness creates choice; choice creates control
- You don't chase perfection — you refine behavior over time
- The body is your base — treat it with respect

Your expertise:
- Type 1 and Type 2 diabetes management
- Glucose pattern recognition and control strategies
- Exercise and glucose dynamics
- Nutrition, carb estimation, and timing
- Insulin sensitivity and behavioral patterns
- Sleep, stress, and metabolic impact
- CGM data interpretation and decision-making

IMPORTANT CONTEXT RULES:
- ONLY mention training/workouts if there is RECENT workout data (within last 48h) in the context
- If no recent workouts exist, DO NOT bring up exercise unprompted
- Time-aware coaching: Don't suggest training at inappropriate times (late night) unless user asks
- Focus on what's actually happening now, not hypothetical scenarios

Communication style:
- Concise, clear, and intentional
- No fluff, but not cold
- You adjust tone depending on the situation:
  * When the user is on track → reinforce and sharpen
  * When they struggle → stabilize, then redirect
- Occasional short motivational lines when they matter
- Emojis are rare and purposeful (✅ ⚠️ 📉 📈 💪)

Spanish slang (modern, internet culture, NOT fatherly):
- Use occasionally: "dale" (let's go), "claro" (of course), "fácil" (easy/relax), "puro flow" (in the flow)
- Keep it current, cool, peer-to-peer — never paternal
- Example: "Dale, that meal timing is solid" or "Fácil, we adjust and keep going"

Core directive:
You are not here to judge or comfort blindly.
You are here to help the user become consistent, aware, and in control — even on imperfect days.`

// Simple auth middleware
const requireAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const token = auth.replace('Bearer ', '');
  req.userId = token;
  next();
};

// Check trial/subscription
const checkAccess = (req, res, next) => {
  const userId = req.userId;
  
  if (!users.has(userId)) {
    users.set(userId, {
      installDate: new Date(),
      isSubscribed: false,
      messageCount: 0,
    });
  }
  
  const user = users.get(userId);
  const trialDays = 2;
  const installDate = new Date(user.installDate);
  const trialEnd = new Date(installDate);
  trialEnd.setDate(trialEnd.getDate() + trialDays);
  
  const now = new Date();
  const isTrialActive = now < trialEnd;
  
  if (!isTrialActive && !user.isSubscribed) {
    return res.status(403).json({ error: 'Subscription required' });
  }
  
  req.user = user;
  req.isTrial = isTrialActive;
  next();
};

// Initialize user memory
const getUserMemory = (userId) => {
  if (!userMemories.has(userId)) {
    userMemories.set(userId, {
      events: [],
      insights: [],
      profile: {},
      conversationHistory: []
    });
  }
  return userMemories.get(userId);
};

// Health check - Railway needs this!
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Empirical Health API',
    version: '1.0.0',
    kimiConfigured: !!KIMI_API_KEY
  });
});

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Get trial status
app.get('/v1/user/trial', requireAuth, (req, res) => {
  const userId = req.userId;
  
  if (!users.has(userId)) {
    return res.json({ isTrial: true, daysLeft: 2 });
  }
  
  const user = users.get(userId);
  const installDate = new Date(user.installDate);
  const trialEnd = new Date(installDate);
  trialEnd.setDate(trialEnd.getDate() + 2);
  
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));
  
  res.json({
    isTrial: now < trialEnd,
    daysLeft,
    isSubscribed: user.isSubscribed,
  });
});

// Main chat endpoint with memory context
app.post('/v1/vicente/chat', requireAuth, checkAccess, async (req, res) => {
  console.log('Received chat request from:', req.userId);
  
  try {
    const { message, context, persona } = req.body;
    const user = req.user;
    const userId = req.userId;
    
    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }
    
    if (!KIMI_API_KEY) {
      return res.status(500).json({ 
        error: 'API not configured',
        message: "AI service not configured. Please try again later! 🦈"
      });
    }
    
    // Rate limiting: 20 messages per minute per user
    const now = Date.now();
    if (!user.lastMessageTime) user.lastMessageTime = [];
    user.lastMessageTime = user.lastMessageTime.filter(t => now - t < 60000);
    
    if (user.lastMessageTime.length > 20) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    user.lastMessageTime.push(now);
    user.messageCount++;
    
    // Get user's memory
    const memory = getUserMemory(userId);
    
    // Build system prompt with memory
    const memoryContext = [];
    
    if (memory.events.length > 0) {
      memoryContext.push(`\nIMPORTANT EVENTS I'VE LOGGED:\n${memory.events.slice(-5).map(e => `- ${e.title} (${e.date}): ${e.details}`).join('\n')}`);
    }
    
    if (memory.insights.length > 0) {
      memoryContext.push(`\nPATTERNS I'VE LEARNED ABOUT YOU:\n${memory.insights.map(i => `- ${i.description}`).join('\n')}`);
    }
    
    if (Object.keys(memory.profile).length > 0) {
      memoryContext.push(`\nYOUR PREFERENCES:\n${Object.entries(memory.profile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
    }

    // Use persona from app if provided, otherwise use default
    const activePersona = persona || VICENTE_PERSONA;
    
    // Add trend arrow legend if glucose data exists
    const trendLegend = context?.currentGlucose?.trend ? `
TREND ARROW LEGEND (LibreView CGM):
1 = ↓ (falling fast)  |  2 = ↘ (falling slowly)  |  3 = → (flat/stable)
4 = ↗ (rising slowly) |  5 = ↑ (rising)          |  6 = ↑↑ (rising fast)` : '';
    
    const systemPrompt = `${activePersona}

Current Health Context:
${JSON.stringify(context || {}, null, 2)}${memoryContext.join('')}${trendLegend}`

You can REMEMBER things about this user. When they tell you something important (food reactions, stress events, preferences, goals), respond with a message and include what you want to remember in this EXACT format at the END of your message:

[MEMORY:logEvent|{"type": "food_reaction", "severity": 4, "title": "Pizza spike", "details": "User ate pizza and spiked to 250", "tags": ["pizza", "high_carb"]}]

Or for preferences:
[MEMORY:setPreference|{"key": "favorite_food", "value": "tacos"}]

Or for insights:
[MEMORY:addInsight|{"patternType": "pizza_reaction", "description": "Pizza consistently causes glucose spikes for this user", "confidence": 85}]

Only use [MEMORY:...] when something is truly worth remembering. Most responses won't need it.`;
    
    // Call Kimi API
    const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'kimi-k2-0905-preview',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Kimi API error:', response.status, errorText);
      throw new Error(`Kimi API error: ${response.status}`);
    }
    
    const data = await response.json();
    let reply = data.choices[0]?.message?.content || "I'm having trouble right now."
    
    // Parse and process memory commands
    const memoryMatches = reply.match(/\[MEMORY:(\w+)\|({.+?})\]/g);
    if (memoryMatches) {
      memoryMatches.forEach(match => {
        const [, action, jsonStr] = match.match(/\[MEMORY:(\w+)\|({.+?})\]/);
        try {
          const data = JSON.parse(jsonStr);
          
          if (action === 'logEvent') {
            memory.events.push({ ...data, date: new Date().toISOString() });
            console.log(`[Memory] Logged event for ${userId}: ${data.title}`);
          } else if (action === 'setPreference') {
            memory.profile[data.key] = data.value;
            console.log(`[Memory] Set preference for ${userId}: ${data.key} = ${data.value}`);
          } else if (action === 'addInsight') {
            memory.insights.push({ ...data, date: new Date().toISOString() });
            console.log(`[Memory] Added insight for ${userId}: ${data.patternType}`);
          }
          
          // Remove the memory command from the reply
          reply = reply.replace(match, '');
        } catch (e) {
          console.error('[Memory] Failed to parse memory command:', e);
        }
      });
    }
    
    // Clean up the reply
    reply = reply.trim();
    
    console.log('Kimi response received');
    res.json({ message: reply });
    
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ 
      error: 'Internal error',
      message: "Having trouble connecting. Try again in a moment. 🦈"
    });
  }
});

// Get user's memory (for debugging)
app.get('/v1/vicente/memory', requireAuth, (req, res) => {
  const memory = getUserMemory(req.userId);
  res.json(memory);
});

// Listen on 0.0.0.0 so Railway can reach it
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🦈 Server running on port ${PORT}`);
});
