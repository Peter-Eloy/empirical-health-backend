const express = require('express');
const cors = require('cors');

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
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-in-production';
const PORT = process.env.PORT || 3000;

// Log startup info
console.log('🦈 Starting Empirical Health API...');
console.log('Port from env:', process.env.PORT);
console.log('Port using:', PORT);
console.log('Kimi API Key present:', !!KIMI_API_KEY);

if (!KIMI_API_KEY) {
  console.warn('⚠️  WARNING: KIMI_API_KEY not set! AI will not work.');
}

// In-memory storage
const users = new Map();

// Vicente's persona
const VICENTE_PERSONA = `You are Don Vicente "El Tiburón" (The Shark), a wise and caring health coach with Cuban/Miami personality. You help people manage diabetes.

Personality:
- Warm, encouraging, supportive like a caring uncle
- Uses occasional Spanish (mijo, vamos, perfecto)
- Calls yourself "El Tiburón"
- Practical medical advice with heart

Expertise: Type 1/2 diabetes, exercise & glucose, nutrition, insulin sensitivity, CGM data.

Be concise (2-4 sentences), warm, use emojis occasionally.`;

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

// Health check - Railway needs this!
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'Empirical Health API',
    version: '1.0.0',
    kimiConfigured: !!KIMI_API_KEY
  });
});

// Health check endpoint for Railway - MUST return 200 quickly
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: Date.now() });
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

// Main chat endpoint
app.post('/v1/vicente/chat', requireAuth, checkAccess, async (req, res) => {
  console.log('Received chat request from:', req.userId);
  console.log('Message:', req.body.message?.substring(0, 50) + '...');
  
  try {
    const { message, context } = req.body;
    const user = req.user;
    
    if (!message) {
      console.log('Error: No message provided');
      return res.status(400).json({ error: 'Message required' });
    }
    
    // Check if Kimi is configured
    if (!KIMI_API_KEY) {
      console.log('Error: Kimi API key not configured');
      return res.json({ 
        message: "Lo siento mijo, I'm not fully configured yet. The admin needs to add the AI API key. Please try again later! 🦈" 
      });
    }
    
    // Rate limiting: 20 messages per minute per user
    const now = Date.now();
    if (!user.lastMessageTime) user.lastMessageTime = [];
    user.lastMessageTime = user.lastMessageTime.filter(t => now - t < 60000);
    
    if (user.lastMessageTime.length > 20) {
      console.log('Rate limit exceeded for user:', req.userId);
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    user.lastMessageTime.push(now);
    user.messageCount++;
    
    // Build system prompt
    const systemPrompt = `${VICENTE_PERSONA}

Current Health Context:
${JSON.stringify(context || {}, null, 2)}

Respond as Don Vicente. Be warm, practical, and concise.`;
    
    console.log('Calling Kimi API...');
    
    // Call Kimi API
    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${KIMI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'kimi-latest',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('Kimi API error:', response.status, error);
      throw new Error(`Kimi API error: ${response.status}`);
    }
    
    const data = await response.json();
    const reply = data.choices[0]?.message?.content || "Lo siento, I'm having trouble right now.";
    
    console.log('Kimi response:', reply.substring(0, 50) + '...');
    res.json({ message: reply });
    
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ 
      error: 'Internal error',
      message: "Ay, mijo, I'm having trouble connecting. Try again in a moment. 🦈"
    });
  }
});

// Start server - MUST use Railway's PORT env var
const server = app.listen(PORT, '0.0.0.0', (err) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`🦈 Empirical Health API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});

// Handle errors
server.on('error', (err) => {
  console.error('Server error:', err);
});
