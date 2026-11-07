// Task texts carrying the words and shapes a keyword rule would look for. The highest rule says none of them may change anything: with the
// same answer from the model, every one of these routes exactly like BASE_TASK. Add a word here when a new keyword rule is imagined.
export const BASE_TASK = 'Rename foo to bar in util.py.';

const WORDS = [
  // realtime_loop
  '抢票', '秒杀', '挂机', '盯盘', '直播间', 'flash sale', 'order book', 'polling', 'game', 'real-time',
  // wants_fast and urgency
  'urgent', 'URGENT', 'Urgent!', 'asap', 'ASAP', '紧急', '尽快', 'fast mode', 'do not use fast mode', 'not urgent',
  // multi_task
  '同时', '并且', '另外', 'and also', 'both', 'as well as',
  // reading only: code_complexity, hallucination_risk
  'review', 'Review', 'REVIEW', '审查', 'audit', 'read-only', 'diagnose', '诊断', 'do not change any code',
  // self
  '?', '？', 'answer directly', '直接回答', 'do not delegate',
  // needs_gui, needs_visual, local_only
  'screenshot', 'click', '点击', 'browser', 'E:/PROJECTS/x', 'public web',
  // reasoning_depth, divergence, context_scale
  'prove', 'architecture', 'brainstorm', 'whole repository', 'system-wide',
];

export const KEYWORD_CORPUS = [
  ...WORDS.map(word => `${BASE_TASK} ${word}`),
  ...WORDS.map(word => `${word} ${BASE_TASK}`),
  ...WORDS,
  // Shapes: a question, a list, a heading, nearly nothing, and a long brief.
  'What is a mutex?',
  '什么是互斥锁？',
  '1. Fix the parser\n2. Translate the docs\n3. Ship the release',
  '# Task\n\n## Step one\n\n- a\n- b\n',
  'x',
  'x'.repeat(39),
  'x'.repeat(240),
  'x'.repeat(15000),
  `抢票 urgent 同时 review ${'x'.repeat(14000)} ?`,
].filter(text => text !== BASE_TASK);
