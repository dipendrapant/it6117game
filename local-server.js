const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "game.sqlite");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const sessions = new Map();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function run(sql) {
  execFileSync("sqlite3", [DB_PATH], { input: `${sql}\n`, encoding: "utf8" });
}

function query(sql) {
  const output = execFileSync("sqlite3", [DB_PATH], {
    input: `.mode json\n${sql}\n`,
    encoding: "utf8"
  }).trim();
  return output ? JSON.parse(output) : [];
}

function one(sql) {
  return query(sql)[0] || null;
}

function nowSql() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, expected] = stored.split(":");
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function initDb() {
  run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_number INTEGER UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      question_order INTEGER NOT NULL,
      question_type TEXT NOT NULL CHECK (question_type IN ('short_text', 'multiple_response')),
      question_text TEXT NOT NULL,
      image_url TEXT,
      correct_answer TEXT,
      expected_word_count INTEGER,
      explanation TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS question_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      option_text TEXT NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      submitted_answer TEXT,
      selected_options TEXT,
      is_correct INTEGER NOT NULL,
      feedback_data TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      current_question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
      completed_question_count INTEGER NOT NULL DEFAULT 0,
      total_question_count INTEGER NOT NULL DEFAULT 0,
      is_day_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, day_id)
    );
    CREATE TABLE IF NOT EXISTS participant_day_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
      access_code TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, day_id)
    );
  `);
  run(`
    DELETE FROM participant_day_access
    WHERE user_id NOT IN (SELECT id FROM users)
       OR day_id NOT IN (SELECT id FROM days);
  `);

  if (!one("SELECT id FROM admins LIMIT 1;")) {
    run(`INSERT INTO admins (email, password_hash, created_at) VALUES ('admin@example.com', ${sqlValue(hashPassword("ChangeMe123!"))}, ${sqlValue(nowSql())});`);
  }

  const dayCount = one("SELECT COUNT(*) AS count FROM days;").count;
  if (dayCount === 0) {
    const days = defaultDays();
    for (const [number, title, description] of days) {
      run(`INSERT INTO days (day_number, title, description, is_active, created_at) VALUES (${number}, ${sqlValue(title)}, ${sqlValue(description)}, 1, ${sqlValue(nowSql())});`);
    }
  }
  updateDefaultDays();

  if (!one("SELECT id FROM users LIMIT 1;")) {
    run(`INSERT INTO users (user_id, name, created_at, is_active) VALUES ('STUDENT002', 'Demo Student', ${sqlValue(nowSql())}, 1);`);
  } else if (one("SELECT id FROM users WHERE user_id = 'STUDENT-001';") && !one("SELECT id FROM users WHERE user_id = 'STUDENT002';")) {
    run("UPDATE users SET user_id = 'STUDENT002' WHERE user_id = 'STUDENT-001';");
  }

  if (!one("SELECT id FROM questions LIMIT 1;")) {
    seedQuestions();
  }
  updateDefaultQuestions();

  ensureAccessCodes();
}

function seedQuestions() {
  const day1 = one("SELECT id FROM days WHERE day_number = 1;");
  const day2 = one("SELECT id FROM days WHERE day_number = 2;");
  addQuestion({
    dayId: day1.id,
    order: 1,
    type: "short_text",
    text: "What process is used to discover useful patterns in large health datasets?",
    correctAnswer: "Data mining",
    expectedWordCount: 2,
    explanation: "Data mining is used to discover patterns, relationships, and useful signals in large datasets."
  });
  addQuestion({
    dayId: day1.id,
    order: 2,
    type: "multiple_response",
    text: "Which of the following are common tasks in health data mining?",
    options: [
      ["Pattern discovery", true],
      ["Clustering similar patients", true],
      ["Association analysis", true],
      ["Video game console", false],
      ["Picture editing software", false],
      ["Anomaly detection", true]
    ],
    explanation: "Health data mining can include pattern discovery, clustering, association analysis, and anomaly detection."
  });
  addQuestion({
    dayId: day2.id,
    order: 1,
    type: "short_text",
    text: "What type of machine learning uses labelled examples?",
    correctAnswer: "Supervised learning",
    expectedWordCount: 2,
    explanation: "Supervised learning uses labelled data to train models that predict labels or outcomes."
  });
}

function defaultDays() {
  return [
    [1, "Health data mining", "Recall and apply core ideas for discovering useful patterns from health data."],
    [2, "Machine learning", "Practice concepts around supervised and unsupervised learning, model training, and evaluation."],
    [3, "Deep neural network, transformer, reinforcement learning", "Review deep neural networks, transformer models, and reinforcement learning concepts."],
    [4, "Regulation and ethics", "Reflect on governance, regulation, privacy, fairness, and ethical use of AI in health data analysis."]
  ];
}

function updateDefaultDays() {
  const replacements = {
    1: ["Introduction to Health Informatics", ...defaultDays()[0].slice(1)],
    2: ["Clinical Data and Standards", ...defaultDays()[1].slice(1)],
    3: ["Decision Support and Safety", ...defaultDays()[2].slice(1)],
    4: ["Privacy, Ethics, and Evaluation", ...defaultDays()[3].slice(1)]
  };
  for (const [dayNumber, [oldTitle, newTitle, newDescription]] of Object.entries(replacements)) {
    run(`
      UPDATE days
      SET title = ${sqlValue(newTitle)}, description = ${sqlValue(newDescription)}
      WHERE day_number = ${sqlValue(Number(dayNumber))} AND title = ${sqlValue(oldTitle)};
    `);
  }
}

function updateDefaultQuestions() {
  const day1 = one("SELECT id FROM days WHERE day_number = 1;");
  const day2 = one("SELECT id FROM days WHERE day_number = 2;");
  if (!day1 || !day2) return;

  run(`
    UPDATE questions
    SET question_text = 'What process is used to discover useful patterns in large health datasets?',
        correct_answer = 'Data mining',
        expected_word_count = 2,
        explanation = 'Data mining is used to discover patterns, relationships, and useful signals in large datasets.'
    WHERE day_id = ${day1.id} AND question_text = 'What does EHR stand for?';
  `);

  const oldCheckbox = one(`
    SELECT id FROM questions
    WHERE day_id = ${day1.id}
      AND question_text = 'Which of the following are examples of health informatics systems?'
    LIMIT 1;
  `);
  if (oldCheckbox) {
    run(`
      UPDATE questions
      SET question_text = 'Which of the following are common tasks in health data mining?',
          explanation = 'Health data mining can include pattern discovery, clustering, association analysis, and anomaly detection.'
      WHERE id = ${oldCheckbox.id};
      DELETE FROM question_options WHERE question_id = ${oldCheckbox.id};
      INSERT INTO question_options (question_id, option_text, is_correct) VALUES
        (${oldCheckbox.id}, 'Pattern discovery', 1),
        (${oldCheckbox.id}, 'Clustering similar patients', 1),
        (${oldCheckbox.id}, 'Association analysis', 1),
        (${oldCheckbox.id}, 'Video game console', 0),
        (${oldCheckbox.id}, 'Picture editing software', 0),
        (${oldCheckbox.id}, 'Anomaly detection', 1);
    `);
  }

  run(`
    UPDATE questions
    SET question_text = 'What type of machine learning uses labelled examples?',
        correct_answer = 'Supervised learning',
        expected_word_count = 2,
        explanation = 'Supervised learning uses labelled data to train models that predict labels or outcomes.'
    WHERE day_id = ${day2.id} AND question_text = 'What standard is often used for modern healthcare interoperability?';
  `);
}

function addQuestion(payload) {
  run(`
    INSERT INTO questions (day_id, question_order, question_type, question_text, image_url, correct_answer, expected_word_count, explanation, created_at)
    VALUES (${sqlValue(payload.dayId)}, ${sqlValue(payload.order)}, ${sqlValue(payload.type)}, ${sqlValue(payload.text)}, ${sqlValue(payload.imageUrl || null)}, ${sqlValue(payload.correctAnswer || null)}, ${sqlValue(payload.expectedWordCount || null)}, ${sqlValue(payload.explanation || "")}, ${sqlValue(nowSql())});
  `);
  const questionId = one("SELECT id FROM questions ORDER BY id DESC LIMIT 1;").id;
  for (const option of payload.options || []) {
    run(`INSERT INTO question_options (question_id, option_text, is_correct) VALUES (${questionId}, ${sqlValue(option[0])}, ${option[1] ? 1 : 0});`);
  }
  return questionId;
}

function makeAccessCode(userCode, dayNumber) {
  const base = String(userCode || "STUDENT").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base}-DAY${dayNumber}`;
}

function fullAccessCode(userCode, dayCode) {
  const studentPart = String(userCode || "").trim();
  const dayPart = String(dayCode || "").trim();
  if (!studentPart) return dayPart;
  if (!dayPart) return studentPart;
  if (dayPart === studentPart || dayPart.startsWith(`${studentPart}-`)) return dayPart;
  return `${studentPart}-${dayPart}`;
}

function availableAccessCode(preferredCode, userId, dayId) {
  const normalized = String(preferredCode || "").trim() || `STUDENT-${userId}-DAY-${dayId}`;
  let candidate = normalized;
  let counter = 2;
  while (one(`
    SELECT id FROM participant_day_access
    WHERE access_code = ${sqlValue(candidate)}
      AND NOT (user_id = ${sqlValue(userId)} AND day_id = ${sqlValue(dayId)})
    LIMIT 1;
  `)) {
    candidate = `${normalized}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function ensureAccessCodes(userId = null) {
  const users = query(`SELECT * FROM users ${userId ? `WHERE id = ${sqlValue(userId)}` : ""} ORDER BY id ASC;`);
  const days = query("SELECT * FROM days ORDER BY day_number ASC;");
  for (const user of users) {
    for (const day of days) {
      const existing = one(`SELECT id, access_code FROM participant_day_access WHERE user_id = ${user.id} AND day_id = ${day.id};`);
      if (!existing) {
        const accessCode = availableAccessCode(makeAccessCode(user.user_id, day.day_number), user.id, day.id);
        run(`
          INSERT INTO participant_day_access (user_id, day_id, access_code, created_at, updated_at)
          VALUES (${user.id}, ${day.id}, ${sqlValue(accessCode)}, ${sqlValue(nowSql())}, ${sqlValue(nowSql())});
        `);
      } else {
        const preferredCode = makeAccessCode(user.user_id, day.day_number);
        const fullCode = existing.access_code.startsWith(`${preferredCode}-`) ? preferredCode : fullAccessCode(user.user_id, existing.access_code);
        if (fullCode !== existing.access_code) {
          const accessCode = availableAccessCode(fullCode, user.id, day.id);
          run(`
            UPDATE participant_day_access
            SET access_code = ${sqlValue(accessCode)}, updated_at = ${sqlValue(nowSql())}
            WHERE id = ${existing.id};
          `);
        }
      }
    }
  }
}

function resetStandardAccessCodes(userId) {
  const user = one(`SELECT * FROM users WHERE id = ${sqlValue(userId)};`);
  if (!user) return;
  const days = query("SELECT * FROM days ORDER BY day_number ASC;");
  ensureAccessCodes(user.id);
  for (const day of days) {
    const accessCode = availableAccessCode(makeAccessCode(user.user_id, day.day_number), user.id, day.id);
    run(`
      UPDATE participant_day_access
      SET access_code = ${sqlValue(accessCode)}, updated_at = ${sqlValue(nowSql())}
      WHERE user_id = ${user.id} AND day_id = ${day.id};
    `);
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(body);
}

function sendJson(res, data, status = 200, headers = {}) {
  send(res, status, data, headers);
}

function notFound(res) {
  sendJson(res, { error: "Not found" }, 404);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(item => {
    const [key, ...rest] = item.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }));
}

function currentAdmin(req) {
  const token = cookies(req).admin_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session.admin;
}

function requireAdmin(req, res) {
  const admin = currentAdmin(req);
  if (!admin) {
    sendJson(res, { error: "Admin login required" }, 401);
    return null;
  }
  return admin;
}

function normalizeAnswer(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function characterFeedback(expectedWord, typedWord) {
  const chars = [];
  let prefixMatches = true;
  let correctPrefixCount = 0;
  for (let i = 0; i < typedWord.length; i += 1) {
    const expected = expectedWord[i] || "";
    const typed = typedWord[i] || "";
    if (expected && typed && prefixMatches && expected === typed) {
      correctPrefixCount += 1;
      chars.push({ value: typed, status: "correct" });
    } else if (expected && typed) {
      prefixMatches = false;
      chars.push({ value: typed, status: "incorrect" });
    } else if (typed) {
      chars.push({ value: typed, status: "incorrect" });
    }
  }
  return {
    chars,
    correctPrefixCount,
    expectedLength: expectedWord.length,
    typedLength: typedWord.length,
    missingCharCount: Math.max(expectedWord.length - typedWord.length, 0)
  };
}

function checkShortAnswer(submitted, correctAnswer, expectedWordCount) {
  const expected = normalizeAnswer(correctAnswer);
  const actual = normalizeAnswer(submitted);
  const expectedWords = expected.split(" ").filter(Boolean).slice(0, Number(expectedWordCount || 4));
  const actualWords = actual.split(" ").filter(Boolean);
  const words = expectedWords.map((word, index) => {
    const typed = actualWords[index] || "";
    const charHint = characterFeedback(word, typed);
    return {
      typed,
      position: index + 1,
      status: typed === word ? "correct" : typed ? "partial" : "missing",
      ...charHint
    };
  });
  for (let i = expectedWords.length; i < actualWords.length; i += 1) {
    words.push({ typed: actualWords[i], position: i + 1, status: "extra", ...characterFeedback("", actualWords[i]) });
  }
  return {
    type: "short_text",
    isCorrect: actual === expected && actualWords.length === expectedWords.length,
    normalizedSubmitted: actual,
    expectedWordCount: expectedWords.length,
    typedWordCount: actualWords.length,
    words
  };
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every(value => b.includes(value));
}

function checkMultipleResponse(selectedOptionIds, options) {
  const selected = (selectedOptionIds || []).map(Number).filter(Boolean);
  const correctIds = options.filter(option => option.is_correct === 1).map(option => option.id);
  const correctSelected = selected.filter(id => correctIds.includes(id));
  const missing = correctIds.filter(id => !selected.includes(id));
  const incorrect = selected.filter(id => !correctIds.includes(id));
  return {
    type: "multiple_response",
    isCorrect: arraysEqual([...selected].sort((a, b) => a - b), [...correctIds].sort((a, b) => a - b)),
    correctSelected: arraysEqual([...selected].sort((a, b) => a - b), [...correctIds].sort((a, b) => a - b)) ? correctSelected : [],
    incorrect: [],
    missingCount: missing.length,
    correctSelectedCount: correctSelected.length,
    incorrectCount: incorrect.length,
    message: `You selected ${correctSelected.length} correct option${correctSelected.length === 1 ? "" : "s"}. ${missing.length} correct option${missing.length === 1 ? " is" : "s are"} still missing. ${incorrect.length} selected option${incorrect.length === 1 ? " is" : "s are"} incorrect.`
  };
}

function publicQuestion(question) {
  const copy = { ...question };
  delete copy.correct_answer;
  return copy;
}

function completedQuestionHistory(user, day) {
  const questions = getQuestionsForDay(day.id);
  return questions.map(question => {
    const attempt = one(`
      SELECT submitted_answer, selected_options, created_at
      FROM attempts
      WHERE user_id = ${user.id} AND question_id = ${question.id} AND is_correct = 1
      ORDER BY created_at DESC
      LIMIT 1;
    `);
    if (!attempt) return null;
    let selectedIds = [];
    try {
      selectedIds = JSON.parse(attempt.selected_options || "[]").map(Number);
    } catch {
      selectedIds = [];
    }
    const options = getOptions(question.id);
    return {
      ...publicQuestion(question),
      options,
      completed_at: attempt.created_at,
      submitted_answer: question.question_type === "short_text" ? attempt.submitted_answer : "",
      selected_options: options.filter(option => selectedIds.includes(option.id)).map(option => option.option_text)
    };
  }).filter(Boolean);
}

function getQuestionsForDay(dayId) {
  return query(`SELECT * FROM questions WHERE day_id = ${sqlValue(dayId)} ORDER BY question_order ASC, id ASC;`);
}

function getOptions(questionId, includeCorrect = false) {
  const rows = query(`SELECT id, option_text, is_correct FROM question_options WHERE question_id = ${sqlValue(questionId)} ORDER BY id ASC;`);
  return includeCorrect ? rows : rows.map(({ id, option_text }) => ({ id, option_text }));
}

function participantByUserId(userId) {
  return one(`SELECT * FROM users WHERE user_id = ${sqlValue(userId)} AND is_active = 1;`);
}

function accessByCode(accessCode) {
  const code = String(accessCode || "").trim();
  return one(`
    SELECT
      pda.access_code,
      u.id AS user_id_pk,
      u.user_id AS participant_code,
      u.name,
      u.is_active,
      d.id AS day_id,
      d.day_number,
      d.title,
      d.description,
      d.is_active AS day_is_active,
      d.created_at AS day_created_at
    FROM participant_day_access pda
    JOIN users u ON u.id = pda.user_id
    JOIN days d ON d.id = pda.day_id
    WHERE pda.access_code = ${sqlValue(code)}
       OR (u.user_id || '-' || pda.access_code) = ${sqlValue(code)}
       OR (u.user_id || '-DAY' || d.day_number) = ${sqlValue(code)}
    LIMIT 1;
  `);
}

function participantAccessCodes(userId) {
  return query(`
    SELECT pda.id, pda.access_code, d.id AS day_id, d.day_number, d.title
    FROM participant_day_access pda
    JOIN days d ON d.id = pda.day_id
    WHERE pda.user_id = ${sqlValue(userId)}
    ORDER BY d.day_number ASC;
  `);
}

function ensureProgress(user, day) {
  const questions = getQuestionsForDay(day.id);
  const completedIds = query(`
    SELECT DISTINCT question_id FROM attempts
    WHERE user_id = ${user.id} AND is_correct = 1
      AND question_id IN (SELECT id FROM questions WHERE day_id = ${day.id});
  `).map(row => row.question_id);
  const current = questions.find(q => !completedIds.includes(q.id)) || null;
  const completedCount = completedIds.length;
  const isCompleted = questions.length > 0 && completedCount >= questions.length;
  const existing = one(`SELECT * FROM progress WHERE user_id = ${user.id} AND day_id = ${day.id};`);
  const completedAt = isCompleted ? (existing?.completed_at || nowSql()) : null;
  if (existing) {
    run(`
      UPDATE progress SET
        current_question_id = ${sqlValue(current?.id || null)},
        completed_question_count = ${completedCount},
        total_question_count = ${questions.length},
        is_day_completed = ${isCompleted ? 1 : 0},
        completed_at = ${sqlValue(completedAt)},
        updated_at = ${sqlValue(nowSql())}
      WHERE id = ${existing.id};
    `);
  } else {
    run(`
      INSERT INTO progress (user_id, day_id, current_question_id, completed_question_count, total_question_count, is_day_completed, completed_at, updated_at)
      VALUES (${user.id}, ${day.id}, ${sqlValue(current?.id || null)}, ${completedCount}, ${questions.length}, ${isCompleted ? 1 : 0}, ${sqlValue(completedAt)}, ${sqlValue(nowSql())});
    `);
  }
  return one(`SELECT * FROM progress WHERE user_id = ${user.id} AND day_id = ${day.id};`);
}

function progressSummaryForUser(user) {
  const days = query("SELECT * FROM days ORDER BY day_number ASC;");
  return days.map(day => {
    const progress = ensureProgress(user, day);
    const attempts = one(`
      SELECT COUNT(*) AS count FROM attempts
      WHERE user_id = ${user.id} AND question_id IN (SELECT id FROM questions WHERE day_id = ${day.id});
    `).count;
    return {
      day,
      progress,
      attempts,
      percent: progress.total_question_count ? Math.round((progress.completed_question_count / progress.total_question_count) * 100) : 0
    };
  });
}

function progressReport() {
  const participants = query("SELECT * FROM users ORDER BY created_at DESC;");
  const days = query("SELECT * FROM days ORDER BY day_number ASC;");
  const rows = [];
  for (const user of participants) {
    for (const day of days) {
      const progress = ensureProgress(user, day);
      const attempts = one(`
        SELECT COUNT(*) AS count FROM attempts
        WHERE user_id = ${user.id} AND question_id IN (SELECT id FROM questions WHERE day_id = ${day.id});
      `).count;
      const currentQuestion = progress.current_question_id
        ? one(`SELECT question_order FROM questions WHERE id = ${progress.current_question_id};`)?.question_order
        : null;
      rows.push({
        participant_id: user.user_id,
        name: user.name || "",
        day_number: day.day_number,
        day_title: day.title,
        completed_questions: progress.completed_question_count,
        total_questions: progress.total_question_count,
        percent_completed: progress.total_question_count ? Math.round((progress.completed_question_count / progress.total_question_count) * 100) : 0,
        attempts,
        current_question: currentQuestion || "",
        completed: progress.is_day_completed === 1 ? "completed" : "not completed"
      });
    }
  }
  return rows;
}

function progressMatrix() {
  const participants = query("SELECT * FROM users ORDER BY created_at DESC;");
  return participants.map(user => {
    const days = progressSummaryForUser(user).map(({ day, progress, attempts, percent }) => ({
      day_id: day.id,
      day_number: day.day_number,
      day_title: day.title,
      access_code: participantAccessCodes(user.id).find(code => code.day_id === day.id)?.access_code || "",
      completed_questions: progress.completed_question_count,
      total_questions: progress.total_question_count,
      percent_completed: percent,
      attempts,
      current_question: progress.current_question_id
        ? one(`SELECT question_order FROM questions WHERE id = ${progress.current_question_id};`)?.question_order || ""
        : "",
      completed: progress.is_day_completed === 1
    }));
    return {
      id: user.id,
      participant_id: user.user_id,
      name: user.name || "",
      is_active: user.is_active,
      days
    };
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/student/login") {
      const body = await parseJsonBody(req);
      const access = accessByCode(body.accessCode || body.userId);
      if (!access || access.is_active !== 1 || access.day_is_active !== 1) {
        return sendJson(res, { error: "That day access ID was not found or is inactive." }, 404);
      }
      const user = { id: access.user_id_pk, user_id: access.participant_code, name: access.name };
      const day = {
        id: access.day_id,
        day_number: access.day_number,
        title: access.title,
        description: access.description,
        is_active: access.day_is_active,
        created_at: access.day_created_at
      };
      const progress = ensureProgress(user, day);
      const current = progress.current_question_id ? one(`SELECT * FROM questions WHERE id = ${progress.current_question_id};`) : null;
      return sendJson(res, {
        accessCode: access.access_code,
        user: { user_id: user.user_id, name: user.name },
        day,
        progress,
        percent: progress.total_question_count ? Math.round((progress.completed_question_count / progress.total_question_count) * 100) : 0,
        currentQuestion: current ? { ...publicQuestion(current), options: getOptions(current.id) } : null,
        history: completedQuestionHistory(user, day)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/student/days") {
      const access = accessByCode(url.searchParams.get("accessCode") || url.searchParams.get("userId"));
      if (!access || access.is_active !== 1 || access.day_is_active !== 1) return sendJson(res, { error: "Invalid day access ID" }, 401);
      const user = { id: access.user_id_pk, user_id: access.participant_code, name: access.name };
      const day = {
        id: access.day_id,
        day_number: access.day_number,
        title: access.title,
        description: access.description,
        is_active: access.day_is_active,
        created_at: access.day_created_at
      };
      return sendJson(res, { days: [{ day, progress: ensureProgress(user, day), attempts: 0, percent: 0 }] });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/student/day/")) {
      const dayId = Number(url.pathname.split("/").pop());
      const access = accessByCode(url.searchParams.get("accessCode") || url.searchParams.get("userId"));
      if (!access || access.is_active !== 1 || access.day_is_active !== 1 || access.day_id !== dayId) {
        return sendJson(res, { error: "This access ID does not unlock that day." }, 404);
      }
      const user = { id: access.user_id_pk, user_id: access.participant_code, name: access.name };
      const day = {
        id: access.day_id,
        day_number: access.day_number,
        title: access.title,
        description: access.description,
        is_active: access.day_is_active,
        created_at: access.day_created_at
      };
      const progress = ensureProgress(user, day);
      const questions = getQuestionsForDay(day.id);
      const current = progress.current_question_id ? questions.find(q => q.id === progress.current_question_id) : null;
      return sendJson(res, {
        day,
        progress,
        percent: progress.total_question_count ? Math.round((progress.completed_question_count / progress.total_question_count) * 100) : 0,
        currentQuestion: current ? { ...publicQuestion(current), options: getOptions(current.id) } : null,
        history: completedQuestionHistory(user, day)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/student/attempt") {
      const body = await parseJsonBody(req);
      const access = accessByCode(body.accessCode || body.userId);
      const user = access ? { id: access.user_id_pk, user_id: access.participant_code, name: access.name } : null;
      const question = one(`SELECT * FROM questions WHERE id = ${sqlValue(body.questionId)};`);
      if (!access || access.is_active !== 1 || access.day_is_active !== 1 || !user || !question || question.day_id !== access.day_id) {
        return sendJson(res, { error: "Invalid day access ID or question" }, 404);
      }
      const day = one(`SELECT * FROM days WHERE id = ${question.day_id};`);
      const progress = ensureProgress(user, day);
      if (progress.current_question_id !== question.id && progress.is_day_completed !== 1) {
        return sendJson(res, { error: "Please complete the current question first." }, 409);
      }
      const options = getOptions(question.id, true);
      const feedback = question.question_type === "short_text"
        ? checkShortAnswer(body.answer, question.correct_answer, question.expected_word_count)
        : checkMultipleResponse(body.selectedOptionIds, options);
      const previousAttempts = one(`SELECT COUNT(*) AS count FROM attempts WHERE user_id = ${user.id} AND question_id = ${question.id};`).count;
      run(`
        INSERT INTO attempts (user_id, question_id, submitted_answer, selected_options, is_correct, feedback_data, attempt_number, created_at)
        VALUES (${user.id}, ${question.id}, ${sqlValue(body.answer || "")}, ${sqlValue(JSON.stringify(body.selectedOptionIds || []))}, ${feedback.isCorrect ? 1 : 0}, ${sqlValue(JSON.stringify(feedback))}, ${previousAttempts + 1}, ${sqlValue(nowSql())});
      `);
      const updatedProgress = ensureProgress(user, day);
      const nextQuestion = updatedProgress.current_question_id
        ? one(`SELECT * FROM questions WHERE id = ${updatedProgress.current_question_id};`)
        : null;
      return sendJson(res, {
        isCorrect: feedback.isCorrect,
        feedback,
        explanation: feedback.isCorrect ? question.explanation : "",
        progress: updatedProgress,
        nextQuestion: feedback.isCorrect && nextQuestion ? { ...publicQuestion(nextQuestion), options: getOptions(nextQuestion.id) } : null,
        history: completedQuestionHistory(user, day)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await parseJsonBody(req);
      const admin = one(`SELECT * FROM admins WHERE email = ${sqlValue(body.email)};`);
      if (!admin || !verifyPassword(body.password || "", admin.password_hash)) {
        return sendJson(res, { error: "Invalid admin email or password" }, 401);
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { admin: { id: admin.id, email: admin.email }, expiresAt: Date.now() + SESSION_TTL_MS });
      return sendJson(res, { admin: { email: admin.email } }, 200, {
        "Set-Cookie": `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`
      });
    }

    if (url.pathname.startsWith("/api/admin")) {
      if (!requireAdmin(req, res)) return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/me") {
      return sendJson(res, { admin: currentAdmin(req) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      const token = cookies(req).admin_session;
      if (token) sessions.delete(token);
      return sendJson(res, { ok: true }, 200, { "Set-Cookie": "admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/participants") {
      ensureAccessCodes();
      const participants = query("SELECT id, user_id, name, created_at, is_active FROM users ORDER BY created_at DESC;")
        .map(user => ({ ...user, access_codes: participantAccessCodes(user.id) }));
      return sendJson(res, { participants });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/participants") {
      const body = await parseJsonBody(req);
      const userId = body.userId || `HI-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      run(`INSERT INTO users (user_id, name, created_at, is_active) VALUES (${sqlValue(userId)}, ${sqlValue(body.name || "")}, ${sqlValue(nowSql())}, 1);`);
      const participant = one("SELECT * FROM users ORDER BY id DESC LIMIT 1;");
      resetStandardAccessCodes(participant.id);
      return sendJson(res, { participant: { ...participant, access_codes: participantAccessCodes(participant.id) } }, 201);
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/admin/participants/")) {
      const id = Number(url.pathname.split("/").pop());
      const body = await parseJsonBody(req);
      run(`UPDATE users SET user_id = ${sqlValue(body.userId)}, name = ${sqlValue(body.name || "")}, is_active = ${body.isActive ? 1 : 0} WHERE id = ${id};`);
      resetStandardAccessCodes(id);
      const participant = one(`SELECT * FROM users WHERE id = ${id};`);
      return sendJson(res, { participant: { ...participant, access_codes: participantAccessCodes(id) } });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/participants/")) {
      run(`DELETE FROM users WHERE id = ${Number(url.pathname.split("/").pop())};`);
      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/reset-progress") {
      const body = await parseJsonBody(req);
      const userClause = body.userId ? `AND user_id = ${sqlValue(body.userId)}` : "";
      const questionDayClause = body.dayId ? `AND question_id IN (SELECT id FROM questions WHERE day_id = ${sqlValue(body.dayId)})` : "";
      const progressDayClause = body.dayId ? `AND day_id = ${sqlValue(body.dayId)}` : "";
      run(`DELETE FROM attempts WHERE 1 = 1 ${userClause} ${questionDayClause};`);
      run(`DELETE FROM progress WHERE 1 = 1 ${userClause} ${progressDayClause};`);
      return sendJson(res, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/days") {
      const days = query("SELECT * FROM days ORDER BY day_number ASC;");
      return sendJson(res, { days: days.map(day => ({ ...day, questions: getQuestionsForDay(day.id).map(q => ({ ...q, options: getOptions(q.id, true) })) })) });
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/admin/days/")) {
      const id = Number(url.pathname.split("/").pop());
      const body = await parseJsonBody(req);
      run(`UPDATE days SET title = ${sqlValue(body.title)}, description = ${sqlValue(body.description)}, is_active = ${body.isActive ? 1 : 0} WHERE id = ${id};`);
      return sendJson(res, { day: one(`SELECT * FROM days WHERE id = ${id};`) });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/questions") {
      const body = await parseJsonBody(req);
      const id = addQuestion({
        dayId: body.dayId,
        order: body.questionOrder,
        type: body.questionType,
        text: body.questionText,
        imageUrl: body.imageUrl,
        correctAnswer: body.correctAnswer,
        expectedWordCount: body.expectedWordCount,
        explanation: body.explanation,
        options: (body.options || []).map(option => [option.optionText, Boolean(option.isCorrect)])
      });
      return sendJson(res, { question: one(`SELECT * FROM questions WHERE id = ${id};`) }, 201);
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/admin/questions/")) {
      const id = Number(url.pathname.split("/").pop());
      const body = await parseJsonBody(req);
      run(`
        UPDATE questions SET
          day_id = ${sqlValue(body.dayId)},
          question_order = ${sqlValue(body.questionOrder)},
          question_type = ${sqlValue(body.questionType)},
          question_text = ${sqlValue(body.questionText)},
          image_url = ${sqlValue(body.imageUrl || null)},
          correct_answer = ${sqlValue(body.correctAnswer || null)},
          expected_word_count = ${sqlValue(body.expectedWordCount || null)},
          explanation = ${sqlValue(body.explanation || "")}
        WHERE id = ${id};
      `);
      run(`DELETE FROM question_options WHERE question_id = ${id};`);
      for (const option of body.options || []) {
        run(`INSERT INTO question_options (question_id, option_text, is_correct) VALUES (${id}, ${sqlValue(option.optionText)}, ${option.isCorrect ? 1 : 0});`);
      }
      return sendJson(res, { question: one(`SELECT * FROM questions WHERE id = ${id};`) });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/questions/")) {
      run(`DELETE FROM questions WHERE id = ${Number(url.pathname.split("/").pop())};`);
      return sendJson(res, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/progress") {
      return sendJson(res, { rows: progressReport(), matrix: progressMatrix() });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/export.csv") {
      const rows = progressReport();
      const headers = Object.keys(rows[0] || {
        participant_id: "", name: "", day_number: "", day_title: "", completed_questions: "", total_questions: "", percent_completed: "", attempts: "", current_question: "", completed: ""
      });
      const csv = [headers.join(","), ...rows.map(row => headers.map(key => csvEscape(row[key])).join(","))].join("\n");
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=health-informatics-progress.csv"
      });
      return res.end(csv);
    }

    return notFound(res);
  } catch (error) {
    console.error(error);
    return sendJson(res, { error: error.message || "Server error" }, 500);
  }
}

function serveStatic(req, res, url) {
  let filePath = url.pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, "index.html");
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

initDb();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`Close the other server or start this app on another port, for example: PORT=${PORT + 1} npm start`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`IT6117-Helsedataanalyse med KI game running at http://localhost:${PORT}`);
  console.log("Default admin: admin@example.com / ChangeMe123!");
  console.log("Example Day 1 access ID format: STUDENT002-DAY1");
});
