const express = require('express');
const cors = require('cors');
const { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const app = express();
const PORT = process.env.PORT || 8080;
const IMAGE_MODEL_ID = process.env.BEDROCK_IMAGE_MODEL || 'amazon.nova-canvas-v1:0';

app.use(cors());
app.use(express.json());

// ─── AWS Bedrock (Llama 3.3 70B AI) ───
const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

async function askAI(prompt, maxTokens = 500) {
  const command = new ConverseCommand({
    modelId: 'us.meta.llama3-3-70b-instruct-v1:0',
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens, temperature: 0.7 }
  });
  const response = await bedrock.send(command);
  return response.output.message.content[0].text;
}

async function generateImage(prompt, options = {}) {
  const width = Math.min(Math.max(Number(options.width) || 1024, 256), 2048);
  const height = Math.min(Math.max(Number(options.height) || 1024, 256), 2048);
  const seed = Number.isInteger(Number(options.seed)) ? Number(options.seed) : Math.floor(Math.random() * 1000000);

  const payload = {
    taskType: 'TEXT_IMAGE',
    textToImageParams: {
      text: prompt,
      negativeText: typeof options.negativePrompt === 'string' ? options.negativePrompt : ''
    },
    imageGenerationConfig: {
      width,
      height,
      quality: 'standard',
      cfgScale: 8,
      seed,
      numberOfImages: 1
    }
  };

  const command = new InvokeModelCommand({
    modelId: IMAGE_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload)
  });

  const response = await bedrock.send(command);
  const bodyJson = JSON.parse(new TextDecoder().decode(response.body));
  const imageBase64 = bodyJson?.images?.[0];

  if (!imageBase64) {
    throw new Error('Bedrock returned no image data');
  }

  return {
    imageBase64,
    width,
    height,
    seed,
    modelId: IMAGE_MODEL_ID
  };
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateFallbackImage(prompt, options = {}) {
  const width = Math.min(Math.max(Number(options.width) || 1024, 256), 2048);
  const height = Math.min(Math.max(Number(options.height) || 1024, 256), 2048);
  const safePrompt = escapeXml(prompt).slice(0, 180);
  const ts = new Date().toISOString();

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b1020" />
      <stop offset="50%" stop-color="#1d3557" />
      <stop offset="100%" stop-color="#2a9d8f" />
    </linearGradient>
    <linearGradient id="line" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#93c5fd" />
      <stop offset="100%" stop-color="#86efac" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${Math.round(width * 0.8)}" cy="${Math.round(height * 0.22)}" r="${Math.round(width * 0.15)}" fill="#ffffff22"/>
  <circle cx="${Math.round(width * 0.15)}" cy="${Math.round(height * 0.82)}" r="${Math.round(width * 0.22)}" fill="#10b98122"/>
  <rect x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.12)}" width="${Math.round(width * 0.84)}" height="${Math.round(height * 0.76)}" rx="28" fill="#00000044" stroke="url(#line)" stroke-width="2"/>
  <text x="${Math.round(width * 0.12)}" y="${Math.round(height * 0.28)}" fill="#dbeafe" font-size="${Math.max(24, Math.round(width * 0.03))}" font-family="Arial, Helvetica, sans-serif" font-weight="700">Prompt Image (Fallback)</text>
  <foreignObject x="${Math.round(width * 0.12)}" y="${Math.round(height * 0.34)}" width="${Math.round(width * 0.76)}" height="${Math.round(height * 0.34)}">
    <div xmlns="http://www.w3.org/1999/xhtml" style="color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:${Math.max(20, Math.round(width * 0.022))}px;line-height:1.35;word-break:break-word;">
      ${safePrompt}
    </div>
  </foreignObject>
  <text x="${Math.round(width * 0.12)}" y="${Math.round(height * 0.78)}" fill="#93c5fd" font-size="${Math.max(14, Math.round(width * 0.015))}" font-family="Arial, Helvetica, sans-serif">Generated locally at ${escapeXml(ts)}</text>
</svg>`.trim();

  return {
    imageBase64: Buffer.from(svg).toString('base64'),
    width,
    height,
    seed: 0,
    modelId: 'local-svg-fallback',
    mimeType: 'image/svg+xml'
  };
}

// ─── In-Memory Data Store ───
let tasks = [];
let completedToday = [];
let streak = 0;
let totalXP = 0;
let lastActiveDate = new Date().toISOString().split('T')[0];
let nextId = 1;

// ─── AI Task Breaker (Smart Templates) ───
function breakdownTask(taskName) {
  const name = taskName.toLowerCase();
  const steps = [];

  // Pattern-based smart breakdown
  if (name.includes('clean') || name.includes('tidy') || name.includes('organize')) {
    steps.push(
      { text: `Pick ONE area to start (just one spot)`, mins: 2 },
      { text: `Set a timer for 5 minutes and start there`, mins: 5 },
      { text: `Put away 10 items (count them!)`, mins: 5 },
      { text: `Wipe down surfaces in that area`, mins: 5 },
      { text: `Take a 2-min break — you earned it 🎉`, mins: 2 },
      { text: `Move to the next area and repeat`, mins: 10 }
    );
  } else if (name.includes('study') || name.includes('read') || name.includes('learn') || name.includes('homework')) {
    steps.push(
      { text: `Gather your materials (book, notes, laptop)`, mins: 3 },
      { text: `Read/review for just 10 minutes`, mins: 10 },
      { text: `Write 3 key points in your own words`, mins: 5 },
      { text: `Take a 5-min break (walk, stretch)`, mins: 5 },
      { text: `Do 1 practice problem or summarize`, mins: 10 },
      { text: `Review what you learned — done! 🧠`, mins: 2 }
    );
  } else if (name.includes('email') || name.includes('inbox') || name.includes('reply') || name.includes('message')) {
    steps.push(
      { text: `Open inbox — don't read yet, just scan`, mins: 2 },
      { text: `Star/flag the 3 most important ones`, mins: 2 },
      { text: `Reply to the easiest one first (quick win!)`, mins: 3 },
      { text: `Reply to the second one`, mins: 5 },
      { text: `Reply to the third one`, mins: 5 },
      { text: `Archive/delete the rest — inbox zero! 📭`, mins: 3 }
    );
  } else if (name.includes('code') || name.includes('build') || name.includes('program') || name.includes('develop') || name.includes('project')) {
    steps.push(
      { text: `Define what "done" looks like in 1 sentence`, mins: 3 },
      { text: `Open the file/project — just look at it`, mins: 2 },
      { text: `Write the smallest possible first step`, mins: 10 },
      { text: `Test that one thing works`, mins: 5 },
      { text: `Take a quick break 🎮`, mins: 5 },
      { text: `Build the next small piece`, mins: 15 }
    );
  } else if (name.includes('write') || name.includes('essay') || name.includes('report') || name.includes('paper')) {
    steps.push(
      { text: `Write your main idea in 1 sentence`, mins: 3 },
      { text: `List 3 supporting points (bullet points only)`, mins: 5 },
      { text: `Write the first paragraph (ugly draft is fine!)`, mins: 10 },
      { text: `Take a 3-min break`, mins: 3 },
      { text: `Write the next section`, mins: 15 },
      { text: `Read it once and fix obvious things`, mins: 5 }
    );
  } else if (name.includes('exercise') || name.includes('workout') || name.includes('gym') || name.includes('run')) {
    steps.push(
      { text: `Put on workout clothes (that's the hardest part!)`, mins: 3 },
      { text: `Warm up: 2 min stretching`, mins: 2 },
      { text: `Do the first exercise — just 5 reps`, mins: 5 },
      { text: `Keep going for 10 more minutes`, mins: 10 },
      { text: `Cool down and stretch`, mins: 5 },
      { text: `Log it — you showed up! 💪`, mins: 1 }
    );
  } else {
    // Generic breakdown for any task
    steps.push(
      { text: `Define what "${taskName}" looks like when DONE`, mins: 2 },
      { text: `What's the very first tiny action? Do that.`, mins: 5 },
      { text: `Do the next small piece`, mins: 10 },
      { text: `Quick break — check in with yourself`, mins: 3 },
      { text: `Continue for one more focused block`, mins: 10 },
      { text: `Review what you did — celebrate! 🎉`, mins: 2 }
    );
  }

  return steps;
}

// ─── Energy-Based Suggestions ───
function getEnergySuggestions(level) {
  const suggestions = {
    low: {
      emoji: '🔋',
      message: "Low energy is okay. Let's work WITH it, not against it.",
      tasks: [
        'Sort 1 drawer or folder',
        'Reply to 1 easy message',
        'Make a list for tomorrow',
        'Do a 5-min tidy',
        'Watch something educational (counts as productive!)',
      ],
      timer: 15,
      tip: "Set a 15-min timer. Anything you do in 15 min is a WIN."
    },
    medium: {
      emoji: '⚡',
      message: "Nice! Medium energy is great for steady progress.",
      tasks: [
        'Work on your most important task for 25 min',
        'Knock out 3 small tasks',
        'Study or read for 20 min',
        'Do a workout',
        'Work on a creative project',
      ],
      timer: 25,
      tip: "This is your sweet spot. Pick ONE thing and ride the wave."
    },
    high: {
      emoji: '🔥',
      message: "You're ON FIRE! Use this energy for the hard stuff!",
      tasks: [
        'Tackle that task you\'ve been avoiding',
        'Deep work: code, write, or create for 45 min',
        'Do the thing that scares you a little',
        'Plan your whole week',
        'Start something new',
      ],
      timer: 45,
      tip: "Don't waste this! Do the ONE thing that matters most."
    }
  };
  return suggestions[level] || suggestions.medium;
}

// ─── Helper: Update streak ───
function updateStreak() {
  const today = new Date().toISOString().split('T')[0];
  if (lastActiveDate !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    if (lastActiveDate === yesterday) {
      streak++;
    } else {
      streak = 1;
    }
    lastActiveDate = today;
    completedToday = [];
  }
}

// ═══════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'FocusFlow', version: '1.0.0' });
});

// ─── Tasks ───
app.get('/api/tasks', (req, res) => {
  updateStreak();
  res.json({
    tasks,
    currentTask: tasks.length > 0 ? tasks[0] : null,
    totalTasks: tasks.length
  });
});

app.post('/api/tasks', (req, res) => {
  const { name, steps } = req.body;
  if (!name) return res.status(400).json({ error: 'Task name required' });

  const task = {
    id: nextId++,
    name,
    steps: steps || [],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    completed: false
  };
  tasks.push(task);
  res.status(201).json(task);
});

app.post('/api/tasks/:id/complete', (req, res) => {
  updateStreak();
  const id = parseInt(req.params.id);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });

  const task = tasks[idx];
  task.completed = true;
  tasks.splice(idx, 1);

  // Rewards
  const xpEarned = 10 + (task.steps.length * 5);
  totalXP += xpEarned;
  completedToday.push({ ...task, completedAt: new Date().toISOString(), xpEarned });

  const rewards = {
    xpEarned,
    totalXP,
    streak,
    completedToday: completedToday.length,
    message: getCompletionMessage(completedToday.length),
    confetti: true
  };

  res.json({ task, rewards });
});

app.post('/api/tasks/:id/next-step', (req, res) => {
  const id = parseInt(req.params.id);
  const task = tasks.find(t => t.id === id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.currentStep < task.steps.length - 1) {
    task.currentStep++;
    totalXP += 5;
  }
  res.json({ task, xpEarned: 5, totalXP });
});

app.delete('/api/tasks/:id', (req, res) => {
  const id = parseInt(req.params.id);
  tasks = tasks.filter(t => t.id !== id);
  res.json({ deleted: true });
});

// ─── AI Task Breakdown (Real Claude AI!) ───
app.post('/api/ai/breakdown', async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: 'Task description required' });

  try {
    const prompt = `You are an ADHD focus coach. Break this task into 5-7 tiny, concrete steps for someone with ADHD.

Task: "${task}"

Rules:
- Each step should be TINY (2-15 minutes max)
- Be specific and actionable (not vague)
- Include time estimates in minutes
- Add emoji encouragement
- Start easy to build momentum
- Include a break step

Return ONLY valid JSON in this format (no other text):
[{"text": "step description", "mins": 5}, ...]`;

    const aiResponse = await askAI(prompt);
    const steps = JSON.parse(aiResponse.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    const totalMins = steps.reduce((sum, s) => sum + s.mins, 0);

    res.json({
      originalTask: task,
      steps,
      totalMins,
      poweredBy: 'Claude AI (AWS Bedrock)',
      message: `AI broke this into ${steps.length} tiny steps (~${totalMins} min). You got this! 💪`
    });
  } catch (err) {
    // Fallback to pattern-based if AI fails
    const steps = breakdownTask(task);
    const totalMins = steps.reduce((sum, s) => sum + s.mins, 0);
    res.json({
      originalTask: task,
      steps,
      totalMins,
      poweredBy: 'pattern-based (AI unavailable)',
      message: `Broken into ${steps.length} tiny steps (~${totalMins} min total). You got this! 💪`
    });
  }
});

// ─── AI Image Generator (AWS Bedrock) ───
app.post('/api/ai/image', async (req, res) => {
  const { prompt, width, height, seed, negativePrompt } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  if (prompt.length > 700) {
    return res.status(400).json({ error: 'Prompt too long (max 700 chars)' });
  }

  try {
    const image = await generateImage(prompt, { width, height, seed, negativePrompt });
    res.json({
      ...image,
      mimeType: 'image/png',
      imageDataUrl: `data:image/png;base64,${image.imageBase64}`,
      poweredBy: `AWS Bedrock (${image.modelId})`
    });
  } catch (err) {
    console.error('[ai-image-error]', err?.name, err?.message);
    const fallback = generateFallbackImage(prompt, { width, height });
    return res.json({
      ...fallback,
      imageDataUrl: `data:${fallback.mimeType};base64,${fallback.imageBase64}`,
      poweredBy: 'Local SVG Fallback',
      warning: 'Bedrock image model unavailable. Served local generated fallback.'
    });
  }
});

// ─── AI Chat Coach ───
app.post('/api/ai/coach', async (req, res) => {
  const { message, energy, completedToday: doneCount } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  try {
    const context = `You are an ADHD focus coach — warm, practical, brief.
The user's energy is: ${energy || 'unknown'}. They completed ${doneCount || 0} tasks today.
Current streak: ${streak} days. Level: ${Math.floor(totalXP / 100) + 1}.

Respond in 2-3 short sentences max. Be encouraging but practical. Use 1-2 emoji.`;

    const response = await askAI(`${context}\n\nUser: ${message}`, 200);
    res.json({ response, poweredBy: 'Llama 3.3 70B (AWS Bedrock)' });
  } catch (err) {
    res.json({ response: "Keep going — one small step at a time! 💪", poweredBy: 'fallback' });
  }
});

// ─── AI Daily Summary ───
app.get('/api/ai/summary', async (req, res) => {
  updateStreak();
  try {
    const wins = completedToday.map(t => t.name).join(', ') || 'none yet';
    const prompt = `Write a brief, encouraging daily summary for someone with ADHD.
Tasks completed today: ${wins}
Streak: ${streak} days
Level: ${Math.floor(totalXP / 100) + 1}
Total XP: ${totalXP}
Pending tasks: ${tasks.length}

Write 3 short sentences: what they accomplished, encouragement, one suggestion for tomorrow. Use emoji.`;

    const summary = await askAI(prompt, 200);
    res.json({ summary, stats: { completedToday: completedToday.length, streak, totalXP }, poweredBy: 'Llama 3.3 70B (AWS Bedrock)' });
  } catch (err) {
    res.json({ summary: `You completed ${completedToday.length} tasks. Keep the momentum! 🔥`, poweredBy: 'fallback' });
  }
});

// ─── Energy Check-in ───
app.post('/api/energy', (req, res) => {
  const { level } = req.body;
  if (!['low', 'medium', 'high'].includes(level)) {
    return res.status(400).json({ error: 'Level must be: low, medium, or high' });
  }
  res.json(getEnergySuggestions(level));
});

// ─── Stats & Wins ───
app.get('/api/stats', (req, res) => {
  updateStreak();
  res.json({
    totalXP,
    streak,
    level: Math.floor(totalXP / 100) + 1,
    xpToNextLevel: 100 - (totalXP % 100),
    completedToday: completedToday.length,
    todaysWins: completedToday.map(t => ({ name: t.name, xp: t.xpEarned, completedAt: t.completedAt })),
    pendingTasks: tasks.length,
    encouragement: getEncouragement(completedToday.length, streak)
  });
});

// ─── Completion Messages ───
function getCompletionMessage(count) {
  const messages = [
    "You did it! First task done! 🎉",
    "Two down! You're on a roll! 🔥",
    "THREE tasks! You're unstoppable! 💪",
    "Four tasks done — who even ARE you?! 🚀",
    "FIVE TASKS! Legend status! 👑",
  ];
  return messages[Math.min(count - 1, messages.length - 1)] || `${count} tasks done! You're a machine! 🤖`;
}

function getEncouragement(todayCount, currentStreak) {
  if (todayCount === 0 && currentStreak > 0) return `${currentStreak}-day streak! Let's keep it going 🔥`;
  if (todayCount === 0) return "Ready when you are. One small step at a time 🌱";
  if (todayCount >= 5) return "Incredible day! You crushed it 👑";
  if (todayCount >= 3) return "Great momentum! Keep riding the wave 🏄";
  if (todayCount >= 1) return "Progress! Every task counts 💪";
  return "You showed up. That matters 🌟";
}

app.listen(PORT, () => console.log(`🧠 FocusFlow API running on port ${PORT}`));
