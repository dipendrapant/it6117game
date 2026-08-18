const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "change-this-secret-before-deploying";

let supabaseClient;

function supabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "X-Client-Info": "it6117-game-server" } }
    });
  }
  return supabaseClient;
}

function nowSql() {
  return new Date().toISOString();
}

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.statusCode = status;
  for (const [key, value] of Object.entries({
    "Content-Type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  })) {
    res.setHeader(key, value);
  }
  res.end(body);
}

function sendJson(res, data, status = 200, headers = {}) {
  send(res, status, data, headers);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(item => {
    const [key, ...rest] = item.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }));
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function makeSession(admin) {
  const payload = base64url(JSON.stringify({ admin, expiresAt: Date.now() + SESSION_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function currentAdmin(req) {
  const token = cookies(req).admin_session;
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (signature !== sign(payload)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (session.expiresAt < Date.now()) return null;
    return session.admin;
  } catch {
    return null;
  }
}

function requireAdmin(req, res) {
  const admin = currentAdmin(req);
  if (!admin) {
    sendJson(res, { error: "Admin login required" }, 401);
    return null;
  }
  return admin;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, expected] = stored.split(":");
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 120000, 32, "sha256", (error, derivedKey) => {
      if (error) return reject(error);
      const expectedBuffer = Buffer.from(expected, "hex");
      resolve(expectedBuffer.length === derivedKey.length && crypto.timingSafeEqual(derivedKey, expectedBuffer));
    });
  });
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
    } else if (typed) {
      prefixMatches = false;
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
    return {
      typed,
      position: index + 1,
      status: typed === word ? "correct" : typed ? "partial" : "missing",
      ...characterFeedback(word, typed)
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
  const correctIds = options.filter(option => option.is_correct === true).map(option => option.id);
  const correctSelected = selected.filter(id => correctIds.includes(id));
  const missing = correctIds.filter(id => !selected.includes(id));
  const incorrect = selected.filter(id => !correctIds.includes(id));
  const isCorrect = arraysEqual([...selected].sort((a, b) => a - b), [...correctIds].sort((a, b) => a - b));
  return {
    type: "multiple_response",
    isCorrect,
    correctSelected: isCorrect ? correctSelected : [],
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

function makeAccessCode(userCode, dayNumber) {
  const base = String(userCode || "STUDENT").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base}-DAY${dayNumber}`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function one(builder) {
  const { data, error } = await builder.maybeSingle();
  if (error) throw error;
  return data || null;
}

async function many(builder) {
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

async function getQuestionsForDay(db, dayId) {
  return many(db.from("questions").select("*").eq("day_id", dayId).order("question_order", { ascending: true }).order("id", { ascending: true }));
}

async function getOptions(db, questionId, includeCorrect = false) {
  const rows = await many(db.from("question_options").select("id, option_text, is_correct").eq("question_id", questionId).order("id", { ascending: true }));
  return includeCorrect ? rows : rows.map(({ id, option_text }) => ({ id, option_text }));
}

async function availableAccessCode(db, preferredCode, userId, dayId) {
  const normalized = String(preferredCode || "").trim() || `STUDENT-${userId}-DAY-${dayId}`;
  let candidate = normalized;
  let counter = 2;
  while (true) {
    const existing = await one(db.from("participant_day_access").select("id,user_id,day_id").eq("access_code", candidate));
    if (!existing || (existing.user_id === userId && existing.day_id === dayId)) break;
    candidate = `${normalized}-${counter}`;
    counter += 1;
  }
  return candidate;
}

async function ensureAccessCodes(db, userId = null) {
  let userQuery = db.from("users").select("*").order("id", { ascending: true });
  if (userId) userQuery = userQuery.eq("id", userId);
  const users = await many(userQuery);
  const days = await many(db.from("days").select("*").order("day_number", { ascending: true }));
  for (const user of users) {
    for (const day of days) {
      const existing = await one(db.from("participant_day_access").select("id, access_code").eq("user_id", user.id).eq("day_id", day.id));
      const accessCode = await availableAccessCode(db, makeAccessCode(user.user_id, day.day_number), user.id, day.id);
      if (!existing) {
        const { error } = await db.from("participant_day_access").insert({ user_id: user.id, day_id: day.id, access_code: accessCode, created_at: nowSql(), updated_at: nowSql() });
        if (error) throw error;
      } else if (existing.access_code !== accessCode && !existing.access_code.startsWith(accessCode)) {
        const { error } = await db.from("participant_day_access").update({ access_code: accessCode, updated_at: nowSql() }).eq("id", existing.id);
        if (error) throw error;
      }
    }
  }
}

async function resetStandardAccessCodes(db, userId) {
  await ensureAccessCodes(db, userId);
  const user = await one(db.from("users").select("*").eq("id", userId));
  const days = await many(db.from("days").select("*").order("day_number", { ascending: true }));
  for (const day of days) {
    const accessCode = await availableAccessCode(db, makeAccessCode(user.user_id, day.day_number), user.id, day.id);
    const { error } = await db.from("participant_day_access").update({ access_code: accessCode, updated_at: nowSql() }).eq("user_id", user.id).eq("day_id", day.id);
    if (error) throw error;
  }
}

async function participantAccessCodes(db, userId) {
  const rows = await many(db.from("participant_day_access").select("id, access_code, day_id, days(day_number,title)").eq("user_id", userId));
  return rows
    .map(row => ({ id: row.id, access_code: row.access_code, day_id: row.day_id, day_number: row.days.day_number, title: row.days.title }))
    .sort((a, b) => a.day_number - b.day_number);
}

async function accessByCode(db, accessCode) {
  const code = String(accessCode || "").trim();
  let row = await one(db.from("participant_day_access").select("access_code, users(id,user_id,name,is_active), days(id,day_number,title,description,is_active,created_at)").eq("access_code", code));
  if (!row) {
    const match = code.match(/^(.+)-DAY(\d+)$/i);
    if (match) {
      const user = await one(db.from("users").select("*").eq("user_id", match[1]));
      const day = await one(db.from("days").select("*").eq("day_number", Number(match[2])));
      if (user && day) {
        row = await one(db.from("participant_day_access").select("access_code, users(id,user_id,name,is_active), days(id,day_number,title,description,is_active,created_at)").eq("user_id", user.id).eq("day_id", day.id));
      }
    }
  }
  if (!row) return null;
  return {
    access_code: row.access_code,
    user_id_pk: row.users.id,
    participant_code: row.users.user_id,
    name: row.users.name,
    is_active: row.users.is_active,
    day_id: row.days.id,
    day_number: row.days.day_number,
    title: row.days.title,
    description: row.days.description,
    day_is_active: row.days.is_active,
    day_created_at: row.days.created_at
  };
}

async function ensureProgress(db, user, day) {
  const questions = await getQuestionsForDay(db, day.id);
  const [attempts, existing] = await Promise.all([
    many(db.from("attempts").select("question_id").eq("user_id", user.id).eq("is_correct", true).in("question_id", questions.map(q => q.id).length ? questions.map(q => q.id) : [-1])),
    one(db.from("progress").select("*").eq("user_id", user.id).eq("day_id", day.id))
  ]);
  const completedIds = [...new Set(attempts.map(row => row.question_id))];
  const current = questions.find(q => !completedIds.includes(q.id)) || null;
  const completedCount = completedIds.length;
  const isCompleted = questions.length > 0 && completedCount >= questions.length;
  const completedAt = isCompleted ? (existing?.completed_at || nowSql()) : null;
  const payload = {
    user_id: user.id,
    day_id: day.id,
    current_question_id: current?.id || null,
    completed_question_count: completedCount,
    total_question_count: questions.length,
    is_day_completed: isCompleted,
    completed_at: completedAt,
    updated_at: nowSql()
  };
  const { data, error } = await db.from("progress").upsert(payload, { onConflict: "user_id,day_id" }).select("*").single();
  if (error) throw error;
  return data;
}

async function completedQuestionHistory(db, user, day) {
  const questions = await getQuestionsForDay(db, day.id);
  if (!questions.length) return [];
  const questionIds = questions.map(question => question.id);
  const [attempts, optionRows] = await Promise.all([
    many(db.from("attempts").select("question_id, submitted_answer, selected_options, created_at").eq("user_id", user.id).eq("is_correct", true).in("question_id", questionIds).order("created_at", { ascending: false })),
    many(db.from("question_options").select("id, question_id, option_text").in("question_id", questionIds).order("id", { ascending: true }))
  ]);
  const latestAttempts = new Map();
  for (const attempt of attempts) if (!latestAttempts.has(attempt.question_id)) latestAttempts.set(attempt.question_id, attempt);
  return questions.flatMap(question => {
    const attempt = latestAttempts.get(question.id);
    if (!attempt) return [];
    const selectedIds = Array.isArray(attempt.selected_options) ? attempt.selected_options.map(Number) : [];
    const options = optionRows.filter(option => option.question_id === question.id).map(({ id, option_text }) => ({ id, option_text }));
    return [{
      ...publicQuestion(question),
      options,
      completed_at: attempt.created_at,
      submitted_answer: question.question_type === "short_text" ? attempt.submitted_answer : "",
      selected_options: options.filter(option => selectedIds.includes(option.id)).map(option => option.option_text)
    }];
  });
}

async function progressSummaryForUser(db, user) {
  const days = await many(db.from("days").select("*").order("day_number", { ascending: true }));
  const result = [];
  for (const day of days) {
    const progress = await ensureProgress(db, user, day);
    const questions = await getQuestionsForDay(db, day.id);
    const attempts = questions.length ? await many(db.from("attempts").select("id").eq("user_id", user.id).in("question_id", questions.map(q => q.id))) : [];
    result.push({ day, progress, attempts: attempts.length, percent: progress.total_question_count ? Math.round((progress.completed_question_count / progress.total_question_count) * 100) : 0 });
  }
  return result;
}

async function progressReport(db, suppliedSnapshot = null) {
  const snapshot = suppliedSnapshot || await progressSnapshot(db);
  const rows = [];
  for (const user of snapshot.users) {
    for (const item of snapshot.summaries.get(user.id)) {
      rows.push({
        participant_id: user.user_id,
        name: user.name || "",
        day_number: item.day.day_number,
        day_title: item.day.title,
        completed_questions: item.progress.completed_question_count,
        total_questions: item.progress.total_question_count,
        percent_completed: item.percent,
        attempts: item.attempts,
        current_question: item.currentQuestion || "",
        completed: item.progress.is_day_completed ? "completed" : "not completed"
      });
    }
  }
  return rows;
}

async function progressMatrix(db, suppliedSnapshot = null) {
  const snapshot = suppliedSnapshot || await progressSnapshot(db);
  const matrix = [];
  for (const user of snapshot.users) {
    const accessCodes = snapshot.accessCodes.filter(code => code.user_id === user.id);
    const days = [];
    for (const item of snapshot.summaries.get(user.id)) {
      days.push({
        day_id: item.day.id,
        day_number: item.day.day_number,
        day_title: item.day.title,
        access_code: accessCodes.find(code => code.day_id === item.day.id)?.access_code || "",
        completed_questions: item.progress.completed_question_count,
        total_questions: item.progress.total_question_count,
        percent_completed: item.percent,
        attempts: item.attempts,
        current_question: item.currentQuestion || "",
        completed: item.progress.is_day_completed
      });
    }
    matrix.push({ id: user.id, participant_id: user.user_id, name: user.name || "", is_active: user.is_active, days });
  }
  return matrix;
}

async function progressSnapshot(db) {
  const [users, days, questions, attempts, progressRows, accessCodes] = await Promise.all([
    many(db.from("users").select("id,user_id,name,created_at,is_active").order("created_at", { ascending: false })),
    many(db.from("days").select("*").order("day_number", { ascending: true })),
    many(db.from("questions").select("id,day_id,question_order").order("question_order", { ascending: true })),
    many(db.from("attempts").select("user_id,question_id,is_correct")),
    many(db.from("progress").select("*")),
    many(db.from("participant_day_access").select("user_id,day_id,access_code"))
  ]);
  const questionById = new Map(questions.map(question => [question.id, question]));
  const summaries = new Map();
  for (const user of users) {
    summaries.set(user.id, days.map(day => {
      const dayQuestions = questions.filter(question => question.day_id === day.id);
      const questionIds = new Set(dayQuestions.map(question => question.id));
      const userAttempts = attempts.filter(attempt => attempt.user_id === user.id && questionIds.has(attempt.question_id));
      const completedIds = new Set(userAttempts.filter(attempt => attempt.is_correct).map(attempt => attempt.question_id));
      const stored = progressRows.find(row => row.user_id === user.id && row.day_id === day.id);
      const current = dayQuestions.find(question => !completedIds.has(question.id)) || null;
      const completedCount = completedIds.size;
      const completed = dayQuestions.length > 0 && completedCount >= dayQuestions.length;
      const progress = {
        ...(stored || {}), user_id: user.id, day_id: day.id,
        current_question_id: current?.id || null,
        completed_question_count: completedCount,
        total_question_count: dayQuestions.length,
        is_day_completed: completed
      };
      return {
        day, progress, attempts: userAttempts.length,
        percent: dayQuestions.length ? Math.round((completedCount / dayQuestions.length) * 100) : 0,
        currentQuestion: questionById.get(progress.current_question_id)?.question_order || ""
      };
    }));
  }
  return { users, days, questions, accessCodes, summaries };
}

async function addQuestion(db, payload) {
  const question = await one(db.from("questions").insert({
    day_id: payload.dayId,
    question_order: payload.order,
    question_type: payload.type,
    question_text: payload.text,
    image_url: payload.imageUrl || null,
    correct_answer: payload.correctAnswer || null,
    expected_word_count: payload.expectedWordCount || null,
    explanation: payload.explanation || "",
    created_at: nowSql()
  }).select("*"));
  if ((payload.options || []).length) {
    const { error } = await db.from("question_options").insert(payload.options.map(option => ({ question_id: question.id, option_text: option[0], is_correct: option[1] })));
    if (error) throw error;
  }
  return question;
}

async function handler(req, res) {
  const db = supabase();
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    if (req.method === "POST" && path === "/api/student/login") {
      const body = parseBody(req);
      const access = await accessByCode(db, body.accessCode || body.userId);
      if (!access || !access.is_active || !access.day_is_active) return sendJson(res, { error: "That day access ID was not found or is inactive." }, 404);
      const user = { id: access.user_id_pk, user_id: access.participant_code, name: access.name };
      const day = { id: access.day_id, day_number: access.day_number, title: access.title, description: access.description, is_active: access.day_is_active, created_at: access.day_created_at };
      const progress = await ensureProgress(db, user, day);
      const current = progress.current_question_id ? await one(db.from("questions").select("*").eq("id", progress.current_question_id)) : null;
      return sendJson(res, {
        accessCode: access.access_code,
        user: { user_id: user.user_id, name: user.name },
        day,
        progress,
        percent: progress.total_question_count ? Math.round((progress.completed_question_count / progress.total_question_count) * 100) : 0,
        currentQuestion: current ? { ...publicQuestion(current), options: await getOptions(db, current.id) } : null,
        history: await completedQuestionHistory(db, user, day)
      });
    }

    if (req.method === "GET" && path.startsWith("/api/student/day/")) {
      const dayId = Number(path.split("/").pop());
      const access = await accessByCode(db, url.searchParams.get("accessCode") || url.searchParams.get("userId"));
      if (!access || !access.is_active || !access.day_is_active || Number(access.day_id) !== dayId) return sendJson(res, { error: "This access ID does not unlock that day." }, 404);
      const user = { id: access.user_id_pk, user_id: access.participant_code, name: access.name };
      const day = { id: access.day_id, day_number: access.day_number, title: access.title, description: access.description, is_active: access.day_is_active, created_at: access.day_created_at };
      const progress = await ensureProgress(db, user, day);
      const questions = await getQuestionsForDay(db, day.id);
      const current = progress.current_question_id ? questions.find(q => q.id === progress.current_question_id) : null;
      return sendJson(res, {
        day,
        progress,
        percent: progress.total_question_count ? Math.round((progress.completed_question_count / progress.total_question_count) * 100) : 0,
        currentQuestion: current ? { ...publicQuestion(current), options: await getOptions(db, current.id) } : null,
        history: await completedQuestionHistory(db, user, day)
      });
    }

    if (req.method === "POST" && path === "/api/student/attempt") {
      const body = parseBody(req);
      const access = await accessByCode(db, body.accessCode || body.userId);
      const user = access ? { id: access.user_id_pk, user_id: access.participant_code, name: access.name } : null;
      const question = await one(db.from("questions").select("*").eq("id", body.questionId));
      if (!access || !access.is_active || !access.day_is_active || !user || !question || question.day_id !== access.day_id) return sendJson(res, { error: "Invalid day access ID or question" }, 404);
      const day = await one(db.from("days").select("*").eq("id", question.day_id));
      const progress = await ensureProgress(db, user, day);
      if (progress.current_question_id !== question.id && !progress.is_day_completed) return sendJson(res, { error: "Please complete the current question first." }, 409);
      const options = await getOptions(db, question.id, true);
      const feedback = question.question_type === "short_text" ? checkShortAnswer(body.answer, question.correct_answer, question.expected_word_count) : checkMultipleResponse(body.selectedOptionIds, options);
      const previousAttempts = await many(db.from("attempts").select("id").eq("user_id", user.id).eq("question_id", question.id));
      const { error: attemptError } = await db.from("attempts").insert({
        user_id: user.id,
        question_id: question.id,
        submitted_answer: body.answer || "",
        selected_options: body.selectedOptionIds || [],
        is_correct: feedback.isCorrect,
        feedback_data: feedback,
        attempt_number: previousAttempts.length + 1,
        created_at: nowSql()
      });
      if (attemptError) throw attemptError;
      const updatedProgress = await ensureProgress(db, user, day);
      const nextQuestion = updatedProgress.current_question_id ? await one(db.from("questions").select("*").eq("id", updatedProgress.current_question_id)) : null;
      return sendJson(res, {
        isCorrect: feedback.isCorrect,
        feedback,
        explanation: feedback.isCorrect ? question.explanation : "",
        progress: updatedProgress,
        nextQuestion: feedback.isCorrect && nextQuestion ? { ...publicQuestion(nextQuestion), options: await getOptions(db, nextQuestion.id) } : null,
        history: await completedQuestionHistory(db, user, day)
      });
    }

    if (req.method === "POST" && path === "/api/admin/login") {
      const body = parseBody(req);
      const admin = await one(db.from("admins").select("*").eq("email", body.email));
      if (!admin || !(await verifyPassword(body.password || "", admin.password_hash))) return sendJson(res, { error: "Invalid admin email or password" }, 401);
      const token = makeSession({ id: admin.id, email: admin.email });
      return sendJson(res, { admin: { email: admin.email } }, 200, { "Set-Cookie": `admin_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800` });
    }

    if (path.startsWith("/api/admin") && !requireAdmin(req, res)) return;

    if (req.method === "GET" && path === "/api/admin/me") return sendJson(res, { admin: currentAdmin(req) });
    if (req.method === "POST" && path === "/api/admin/logout") return sendJson(res, { ok: true }, 200, { "Set-Cookie": "admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" });

    if (req.method === "GET" && path === "/api/admin/participants") {
      const [users, codes] = await Promise.all([
        many(db.from("users").select("id,user_id,name,created_at,is_active").order("created_at", { ascending: false })),
        many(db.from("participant_day_access").select("id,user_id,day_id,access_code,days(day_number,title)"))
      ]);
      const participants = users.map(user => ({
        ...user,
        access_codes: codes.filter(code => code.user_id === user.id).map(code => ({
          id: code.id, access_code: code.access_code, day_id: code.day_id,
          day_number: code.days.day_number, title: code.days.title
        })).sort((a, b) => a.day_number - b.day_number)
      }));
      return sendJson(res, { participants });
    }

    if (req.method === "POST" && path === "/api/admin/participants") {
      const body = parseBody(req);
      const userId = body.userId || `HI-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const participant = await one(db.from("users").insert({ user_id: userId, name: body.name || "", created_at: nowSql(), is_active: true }).select("*"));
      await resetStandardAccessCodes(db, participant.id);
      return sendJson(res, { participant: { ...participant, access_codes: await participantAccessCodes(db, participant.id) } }, 201);
    }

    if (req.method === "PUT" && path.startsWith("/api/admin/participants/")) {
      const id = Number(path.split("/").pop());
      const body = parseBody(req);
      const participant = await one(db.from("users").update({ user_id: body.userId, name: body.name || "", is_active: Boolean(body.isActive) }).eq("id", id).select("*"));
      await resetStandardAccessCodes(db, id);
      return sendJson(res, { participant: { ...participant, access_codes: await participantAccessCodes(db, id) } });
    }

    if (req.method === "DELETE" && path.startsWith("/api/admin/participants/")) {
      const { error } = await db.from("users").delete().eq("id", Number(path.split("/").pop()));
      if (error) throw error;
      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && path === "/api/admin/reset-progress") {
      const body = parseBody(req);
      let attempts = db.from("attempts").delete().neq("id", 0);
      let progress = db.from("progress").delete().neq("id", 0);
      if (body.userId) {
        attempts = attempts.eq("user_id", body.userId);
        progress = progress.eq("user_id", body.userId);
      }
      if (body.dayId) {
        const questions = await getQuestionsForDay(db, body.dayId);
        attempts = attempts.in("question_id", questions.map(q => q.id).length ? questions.map(q => q.id) : [-1]);
        progress = progress.eq("day_id", body.dayId);
      }
      const { error: attemptsError } = await attempts;
      const { error: progressError } = await progress;
      if (attemptsError || progressError) throw attemptsError || progressError;
      return sendJson(res, { ok: true });
    }

    if (req.method === "GET" && path === "/api/admin/days") {
      const [days, questions, options] = await Promise.all([
        many(db.from("days").select("*").order("day_number", { ascending: true })),
        many(db.from("questions").select("*").order("question_order", { ascending: true }).order("id", { ascending: true })),
        many(db.from("question_options").select("*").order("id", { ascending: true }))
      ]);
      const fullDays = days.map(day => ({ ...day, questions: questions.filter(question => question.day_id === day.id).map(question => ({
        ...question, options: options.filter(option => option.question_id === question.id)
      })) }));
      return sendJson(res, { days: fullDays });
    }

    if (req.method === "PUT" && path.startsWith("/api/admin/days/")) {
      const id = Number(path.split("/").pop());
      const body = parseBody(req);
      const day = await one(db.from("days").update({ title: body.title, description: body.description, is_active: Boolean(body.isActive) }).eq("id", id).select("*"));
      return sendJson(res, { day });
    }

    if (req.method === "POST" && path === "/api/admin/questions") {
      const body = parseBody(req);
      const question = await addQuestion(db, { dayId: body.dayId, order: body.questionOrder, type: body.questionType, text: body.questionText, imageUrl: body.imageUrl, correctAnswer: body.correctAnswer, expectedWordCount: body.expectedWordCount, explanation: body.explanation, options: (body.options || []).map(option => [option.optionText, Boolean(option.isCorrect)]) });
      return sendJson(res, { question }, 201);
    }

    if (req.method === "PUT" && path.startsWith("/api/admin/questions/")) {
      const id = Number(path.split("/").pop());
      const body = parseBody(req);
      const question = await one(db.from("questions").update({ day_id: body.dayId, question_order: body.questionOrder, question_type: body.questionType, question_text: body.questionText, image_url: body.imageUrl || null, correct_answer: body.correctAnswer || null, expected_word_count: body.expectedWordCount || null, explanation: body.explanation || "" }).eq("id", id).select("*"));
      const { error: deleteError } = await db.from("question_options").delete().eq("question_id", id);
      if (deleteError) throw deleteError;
      if ((body.options || []).length) {
        const { error } = await db.from("question_options").insert((body.options || []).map(option => ({ question_id: id, option_text: option.optionText, is_correct: Boolean(option.isCorrect) })));
        if (error) throw error;
      }
      return sendJson(res, { question });
    }

    if (req.method === "DELETE" && path.startsWith("/api/admin/questions/")) {
      const { error } = await db.from("questions").delete().eq("id", Number(path.split("/").pop()));
      if (error) throw error;
      return sendJson(res, { ok: true });
    }

    if (req.method === "GET" && path === "/api/admin/progress") {
      const snapshot = await progressSnapshot(db);
      return sendJson(res, { rows: await progressReport(db, snapshot), matrix: await progressMatrix(db, snapshot) });
    }

    if (req.method === "GET" && path === "/api/admin/export.csv") {
      const rows = await progressReport(db);
      const headers = Object.keys(rows[0] || { participant_id: "", name: "", day_number: "", day_title: "", completed_questions: "", total_questions: "", percent_completed: "", attempts: "", current_question: "", completed: "" });
      const csv = [headers.join(","), ...rows.map(row => headers.map(key => csvEscape(row[key])).join(","))].join("\n");
      return send(res, 200, csv, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=it6117-progress.csv" });
    }

    return sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    return sendJson(res, { error: error.message || "Server error" }, 500);
  }
}

module.exports = handler;
