const app = document.querySelector("#app");

const state = {
  participant: JSON.parse(localStorage.getItem("participantSession") || "null"),
  admin: null,
  view: "student-login",
  days: [],
  activeDay: null,
  question: null,
  reviewQuestion: null,
  feedback: null,
  adminTab: "progress",
  adminData: { participants: [], days: [], progress: [], progressMatrix: [] },
  message: ""
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options
  });
  const isCsv = response.headers.get("content-type")?.includes("text/csv");
  const data = isCsv ? await response.text() : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function html(strings, ...values) {
  return strings.reduce((result, string, index) => result + string + (values[index] ?? ""), "");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

function setView(view) {
  state.view = view;
  state.message = "";
  render();
}

function topbar() {
  return html`
    <header class="topbar">
      <div>
        <div class="brand">IT6117-Helsedataanalyse med KI game</div>
        <div class="small muted">Lecture follow-up practice for recall, brainstorming, and concept checking</div>
      </div>
      <nav class="nav">
        <button onclick="studentHome()">Student</button>
        <button onclick="adminHome()">Admin</button>
      </nav>
    </header>
  `;
}

function render() {
  const content = {
    "student-login": studentLogin,
    "student-days": studentDays,
    "student-question": studentQuestion,
    "admin-login": adminLogin,
    "admin-dashboard": adminDashboard
  }[state.view]();
  app.innerHTML = `<div class="shell">${topbar()}${content}</div>`;
}

async function studentHome() {
  if (state.participant) {
    try {
      await loadStudentDay();
      state.view = "student-question";
    } catch (error) {
      localStorage.removeItem("participantSession");
      state.participant = null;
      state.message = error.message;
      state.view = "student-login";
    }
  } else {
    state.view = "student-login";
  }
  render();
}

function studentLogin() {
  return html`
    <main class="center">
      <section class="panel login-panel stack">
        <div>
          <h1>Enter your day access ID</h1>
          <p class="muted">Use the day access ID your teacher gave you. Each ID opens one lecture day only.</p>
        </div>
        <form onsubmit="loginStudent(event)" class="stack">
          <input name="accessCode" placeholder="Example: STUDENT002-DAY1" autocomplete="off" required />
          <button>Start learning</button>
          ${state.message ? `<p class="error">${escapeHtml(state.message)}</p>` : ""}
        </form>
        <p class="small muted">Example Day 1 ID format: <strong>STUDENT002-DAY1</strong></p>
      </section>
    </main>
  `;
}

async function loginStudent(event) {
  event.preventDefault();
  const accessCode = new FormData(event.target).get("accessCode").trim();
  try {
    const data = await api("/api/student/login", { method: "POST", body: JSON.stringify({ accessCode }) });
    state.participant = { ...data.user, accessCode: data.accessCode, dayId: data.day.id };
    state.activeDay = data;
    state.question = data.currentQuestion;
    state.reviewQuestion = null;
    state.feedback = null;
    localStorage.setItem("participantSession", JSON.stringify(state.participant));
    state.view = "student-question";
  } catch (error) {
    state.message = error.message;
  }
  render();
}

async function loadStudentDay() {
  const data = await api(`/api/student/day/${state.participant.dayId}?accessCode=${encodeURIComponent(state.participant.accessCode)}`);
  state.activeDay = data;
  state.question = data.currentQuestion;
  state.reviewQuestion = null;
  state.feedback = null;
}

function studentDays() {
  return html`
    <main class="page stack">
      <section class="row between">
        <div>
          <h1>Choose today’s lecture day</h1>
          <p class="muted">Signed in as ${escapeHtml(state.participant?.user_id)}</p>
        </div>
        <button class="ghost" onclick="logoutStudent()">Use another day ID</button>
      </section>
      <section class="grid">
        ${state.days.map(({ day, progress, attempts, percent }) => html`
          <article class="day-card card">
            <div class="row between">
              <span class="badge ${progress.is_day_completed ? "done" : "todo"}">Day ${day.day_number}</span>
              <span class="small">${percent}%</span>
            </div>
            <div>
              <h2>${escapeHtml(day.title)}</h2>
              <p class="muted">${escapeHtml(day.description)}</p>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
            <p class="small muted">${progress.completed_question_count} of ${progress.total_question_count} questions solved · ${attempts} attempts</p>
            <button onclick="startDay(${day.id})">${progress.is_day_completed ? "Review day" : "Start or continue"}</button>
          </article>
        `).join("")}
      </section>
    </main>
  `;
}

function logoutStudent() {
  localStorage.removeItem("participantSession");
  state.participant = null;
  state.days = [];
  state.feedback = null;
  state.reviewQuestion = null;
  setView("student-login");
}

async function startDay(dayId) {
  const data = await api(`/api/student/day/${dayId}?accessCode=${encodeURIComponent(state.participant.accessCode)}`);
  state.activeDay = data;
  state.question = data.currentQuestion;
  state.reviewQuestion = null;
  state.feedback = null;
  state.view = "student-question";
  render();
}

function studentQuestion() {
  const day = state.activeDay?.day;
  const progress = state.activeDay?.progress;
  if (!state.question && !state.reviewQuestion) {
    return html`
      <main class="center">
        <section class="panel login-panel stack">
          <span class="badge done">Day ${day?.day_number || ""} complete</span>
          <h1>Congratulations, you are done for today!</h1>
          <p class="muted">Your completion status has been saved.</p>
          ${previousQuestionsPanel()}
          <button onclick="logoutStudent()">Enter another day ID</button>
        </section>
      </main>
    `;
  }
  const percent = progress.total_question_count ? Math.round((progress.completed_question_count / progress.total_question_count) * 100) : 0;
  const displayedQuestion = state.reviewQuestion || state.question;
  const isReviewing = Boolean(state.reviewQuestion);
  return html`
    <main class="page stack">
      <section class="row between">
        <div>
          <span class="badge">Day ${day.day_number}</span>
          <h1>${escapeHtml(day.title)}</h1>
        </div>
        <button class="ghost" onclick="logoutStudent()">Use another day ID</button>
      </section>
      <section class="question-layout">
        <article class="panel stack">
          <div class="row between">
            <strong>${isReviewing ? "Reviewing" : "Question"} ${displayedQuestion.question_order}</strong>
            <span>${isReviewing ? "Solved" : `${progress.completed_question_count} / ${progress.total_question_count}`}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
          ${questionVisual(displayedQuestion)}
          <div class="question-text">${escapeHtml(displayedQuestion.question_text)}</div>
          ${isReviewing ? reviewAnswer(displayedQuestion) : (state.question.question_type === "short_text" ? shortAnswerForm() : checkboxForm())}
          ${!isReviewing && state.feedback ? feedbackPanel() : ""}
        </article>
        <aside class="card stack">
          <h2>Today’s progress</h2>
          <p class="muted">${escapeHtml(day.description)}</p>
          <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
          <strong>${percent}% complete</strong>
          <p class="small muted">You can move forward only after this answer is fully correct.</p>
          ${previousQuestionsPanel()}
        </aside>
      </section>
    </main>
  `;
}

function shortAnswerForm() {
  return html`
    <form onsubmit="submitShortAnswer(event)" class="stack">
      <input name="answer" placeholder="Type a short answer" autocomplete="off" autofocus />
      <button>Submit answer</button>
    </form>
  `;
}

function checkboxForm() {
  return html`
    <form onsubmit="submitCheckboxAnswer(event)" class="stack">
      ${(state.question.options || []).map(option => html`
        <label class="option ${optionFeedbackClass(option.id)}">
          <input type="checkbox" name="option" value="${option.id}" />
          <span>${escapeHtml(option.option_text)}</span>
        </label>
      `).join("")}
      <button>Submit selection</button>
    </form>
  `;
}

function optionFeedbackClass(id) {
  const feedback = state.feedback?.feedback;
  if (!feedback || feedback.type !== "multiple_response") return "";
  if (feedback.isCorrect && feedback.correctSelected.includes(id)) return "correct";
  return "";
}

async function submitShortAnswer(event) {
  event.preventDefault();
  const answer = new FormData(event.target).get("answer");
  await submitAttempt({ answer });
}

async function submitCheckboxAnswer(event) {
  event.preventDefault();
  const selectedOptionIds = [...new FormData(event.target).getAll("option")].map(Number);
  await submitAttempt({ selectedOptionIds });
}

async function submitAttempt(payload) {
  const data = await api("/api/student/attempt", {
    method: "POST",
    body: JSON.stringify({ accessCode: state.participant.accessCode, questionId: state.question.id, ...payload })
  });
  state.activeDay.progress = data.progress;
  state.activeDay.history = data.history || state.activeDay.history || [];
  if (data.isCorrect) {
    state.question = data.nextQuestion;
    state.reviewQuestion = null;
    state.feedback = null;
  } else {
    state.feedback = data;
  }
  render();
}

function questionVisual(question = state.question) {
  if (question.image_url) {
    return `<img class="question-image" src="${escapeHtml(question.image_url)}" alt="">`;
  }
  return html`
    <div class="question-image-placeholder" aria-hidden="true">
      <div class="visual-grid">
        <span></span><span></span><span></span><span></span>
        <span></span><span></span><span></span><span></span>
      </div>
      <strong>Day ${state.activeDay.day.day_number} · Question ${question.question_order}</strong>
    </div>
  `;
}

function previousQuestionsPanel() {
  const history = state.activeDay?.history || [];
  if (!history.length) return `<p class="small muted">Solved questions will appear here for review.</p>`;
  return html`
    <div class="stack">
      <h3>Previous questions</h3>
      <div class="review-list">
        ${history.map(item => html`
          <button class="review-button ${state.reviewQuestion?.id === item.id ? "active" : ""}" onclick="reviewQuestion(${item.id})">
            Q${item.question_order}
          </button>
        `).join("")}
      </div>
      ${state.reviewQuestion ? `<button class="ghost" onclick="backToCurrentQuestion()">${state.question ? "Back to current question" : "Back to completion"}</button>` : ""}
    </div>
  `;
}

function reviewQuestion(questionId) {
  const item = (state.activeDay?.history || []).find(question => question.id === questionId);
  if (!item) return;
  state.reviewQuestion = item;
  state.feedback = null;
  render();
}

function backToCurrentQuestion() {
  state.reviewQuestion = null;
  state.feedback = null;
  render();
}

function reviewAnswer(question) {
  const answer = question.question_type === "short_text"
    ? `<p class="review-answer">${escapeHtml(question.submitted_answer || "")}</p>`
    : `<ul class="review-answer-list">${(question.selected_options || []).map(option => `<li>${escapeHtml(option)}</li>`).join("")}</ul>`;
  return html`
    <section class="feedback stack">
      <strong class="success">Solved answer</strong>
      ${answer}
      ${question.explanation ? `<p>${escapeHtml(question.explanation)}</p>` : ""}
      ${state.question ? `<button class="ghost" onclick="backToCurrentQuestion()">Back to current question</button>` : ""}
    </section>
  `;
}

function feedbackPanel() {
  const data = state.feedback.feedback;
  if (data.type === "short_text") {
    return html`
      <section class="feedback stack">
        <strong class="${state.feedback.isCorrect ? "success" : "muted"}">${state.feedback.isCorrect ? "Correct" : "Keep refining your answer"}</strong>
        <p class="muted">Expected pattern: ${data.expectedWordCount} word${data.expectedWordCount === 1 ? "" : "s"}. Your answer has ${data.typedWordCount}.</p>
        <div class="word-hints">
          ${data.words.map(wordHint).join("")}
        </div>
        ${state.feedback.explanation ? `<p>${escapeHtml(state.feedback.explanation)}</p>` : `<p class="muted">Green means that part of your typed answer is correct. Yellow means close or incomplete. Black means revise that typed part.</p>`}
      </section>
    `;
  }
  return html`
    <section class="feedback stack">
      <strong class="${state.feedback.isCorrect ? "success" : "muted"}">${state.feedback.isCorrect ? "Correct" : "Selection feedback"}</strong>
      <p>${escapeHtml(data.message)}</p>
      ${state.feedback.explanation ? `<p>${escapeHtml(state.feedback.explanation)}</p>` : ""}
    </section>
  `;
}

function wordHint(word) {
  const statusLabel = {
    correct: "Correct word",
    partial: "Close, keep refining",
    missing: "Missing word",
    extra: "Extra word"
  }[word.status] || "Check this word";
  const detail = word.status === "correct"
    ? "Fully matched."
    : word.status === "missing"
      ? "No word typed in this position yet."
      : word.status === "extra"
        ? "This word is not expected here."
        : `${word.correctPrefixCount} starting character${word.correctPrefixCount === 1 ? "" : "s"} correct. ${word.missingCharCount > 0 ? `${word.missingCharCount} more character${word.missingCharCount === 1 ? "" : "s"} needed.` : "Check the later character(s)."}`;
  return html`
    <div class="word-hint ${word.status}">
      <div class="row between">
        <strong>Word ${word.position}</strong>
        <span class="badge ${word.status === "correct" ? "done" : "todo"}">${statusLabel}</span>
      </div>
      ${word.typed ? `<div class="typed-word">${word.chars.map(char => `<span class="char ${char.status}">${escapeHtml(char.value)}</span>`).join("")}</div>` : `<div class="typed-word muted">Not typed yet</div>`}
      <p class="small muted">${escapeHtml(detail)}</p>
    </div>
  `;
}

async function adminHome() {
  try {
    const data = await api("/api/admin/me");
    state.admin = data.admin;
    if (state.admin) {
      await loadAdminData();
      state.view = "admin-dashboard";
    } else {
      state.view = "admin-login";
    }
  } catch {
    state.view = "admin-login";
  }
  render();
}

function adminLogin() {
  return html`
    <main class="center">
      <section class="panel login-panel stack">
        <div>
          <h1>Admin login</h1>
          <p class="muted">Manage participants, lecture days, questions, and progress exports.</p>
        </div>
        <form onsubmit="loginAdmin(event)" class="stack">
          <input name="email" type="email" value="admin@example.com" required />
          <input name="password" type="password" value="ChangeMe123!" required />
          <button>Open dashboard</button>
          ${state.message ? `<p class="error">${escapeHtml(state.message)}</p>` : ""}
        </form>
      </section>
    </main>
  `;
}

async function loginAdmin(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const data = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") })
    });
    state.admin = data.admin;
    await loadAdminData();
    state.view = "admin-dashboard";
  } catch (error) {
    state.message = error.message;
  }
  render();
}

async function loadAdminData() {
  const [participants, days, progress] = await Promise.all([
    api("/api/admin/participants"),
    api("/api/admin/days"),
    api("/api/admin/progress")
  ]);
  state.adminData = {
    participants: participants.participants,
    days: days.days,
    progress: progress.rows,
    progressMatrix: progress.matrix || []
  };
}

function adminDashboard() {
  return html`
    <main class="page stack">
      <section class="row between">
        <div>
          <h1>Admin dashboard</h1>
          <p class="muted">Signed in as ${escapeHtml(state.admin?.email || "")}</p>
        </div>
        <button class="ghost" onclick="logoutAdmin()">Log out</button>
      </section>
      <div class="tabs">
        ${["progress", "participants", "days", "questions"].map(tab => `<button class="${state.adminTab === tab ? "active" : ""}" onclick="setAdminTab('${tab}')">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join("")}
      </div>
      ${state.message ? `<p class="success">${escapeHtml(state.message)}</p>` : ""}
      ${adminTabContent()}
    </main>
  `;
}

function setAdminTab(tab) {
  state.adminTab = tab;
  state.message = "";
  render();
}

function adminTabContent() {
  if (state.adminTab === "participants") return participantsAdmin();
  if (state.adminTab === "days") return daysAdmin();
  if (state.adminTab === "questions") return questionsAdmin();
  return progressAdmin();
}

function progressAdmin() {
  return html`
    <section class="stack">
      <div class="row between">
        <h2>Progress by student and day</h2>
        <div class="row">
          <button class="secondary" onclick="resetAllProgress()">Reset all sessions</button>
          <a href="/api/admin/export.csv"><button>Export CSV</button></a>
        </div>
      </div>
      <div class="student-progress-list">
        ${state.adminData.progressMatrix.map(student => html`
          <article class="card stack">
            <div class="row between">
              <div>
                <h3>${escapeHtml(student.participant_id)}</h3>
                <p class="muted">${escapeHtml(student.name || "Unnamed student")}</p>
              </div>
              <span class="badge ${student.is_active ? "done" : "todo"}">${student.is_active ? "Active" : "Inactive"}</span>
            </div>
            <div class="day-progress-grid">
              ${student.days.map(day => html`
                <div class="day-progress-cell ${day.completed ? "completed" : ""}">
                  <div class="row between">
                    <strong>Day ${day.day_number}</strong>
                    <span class="badge ${day.completed ? "done" : "todo"}">${day.completed ? "All completed" : `${day.percent_completed}%`}</span>
                  </div>
                  <p>${escapeHtml(day.day_title)}</p>
                  <div class="progress-track"><div class="progress-fill" style="width:${day.percent_completed}%"></div></div>
                  <p class="small">${day.completed_questions} of ${day.total_questions} questions completed</p>
                  <p class="small muted">${day.attempts} attempts · Current question: ${escapeHtml(day.current_question || "Done/none")}</p>
                  <p class="small muted">Access ID: <strong>${escapeHtml(day.access_code)}</strong></p>
                  <button class="secondary" onclick="resetStudentProgress(${student.id}, ${day.day_id})">Reset Day ${day.day_number}</button>
                </div>
              `).join("")}
            </div>
            <button class="ghost" onclick="resetStudentProgress(${student.id})">Reset all days for this student</button>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function participantsAdmin() {
  return html`
    <section class="stack">
      <form class="panel stack" onsubmit="createParticipant(event)">
        <h2>Create student</h2>
        <div class="form-grid">
          <label class="small">Student ID
            <input name="userId" placeholder="Example: STUDENT002" required />
          </label>
          <label class="small">Full name
            <input name="name" placeholder="Example: Amina Hassan" required />
          </label>
        </div>
        <p class="small muted">Day access IDs are generated automatically as StudentID-DAY1, StudentID-DAY2, StudentID-DAY3, and StudentID-DAY4.</p>
        <button>Add student</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Student ID and day IDs</th><th>Full name</th><th>Active</th><th>Actions</th></tr></thead>
          <tbody>
            ${state.adminData.participants.map(user => html`
              <tr>
                <td>
                  <input id="uid-${user.id}" value="${escapeHtml(user.user_id)}" />
                  <div class="access-code-list">
                    ${(user.access_codes || []).map(code => html`
                      <p class="small">Day ${code.day_number}: <strong>${escapeHtml(code.access_code)}</strong></p>
                    `).join("")}
                  </div>
                </td>
                <td><input id="name-${user.id}" value="${escapeHtml(user.name || "")}" /></td>
                <td><input id="active-${user.id}" type="checkbox" ${user.is_active ? "checked" : ""} /></td>
                <td class="row">
                  <button onclick="updateParticipant(${user.id})">Save</button>
                  <button class="secondary" onclick="deleteParticipant(${user.id})">Delete</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function daysAdmin() {
  return html`
    <section class="grid">
      ${state.adminData.days.map(day => html`
        <form class="card stack" onsubmit="updateDay(event, ${day.id})">
          <span class="badge">Day ${day.day_number}</span>
          <input name="title" value="${escapeHtml(day.title)}" required />
          <textarea name="description" required>${escapeHtml(day.description)}</textarea>
          <label class="row"><input style="width:auto" name="isActive" type="checkbox" ${day.is_active ? "checked" : ""}/> Active</label>
          <button>Save day</button>
        </form>
      `).join("")}
    </section>
  `;
}

function questionsAdmin() {
  return html`
    <section class="stack">
      <form class="panel stack" onsubmit="saveQuestion(event)">
        <h2>Add question</h2>
        <div class="form-grid">
          <select name="dayId">${state.adminData.days.map(day => `<option value="${day.id}">Day ${day.day_number}</option>`).join("")}</select>
          <input name="questionOrder" type="number" min="1" value="1" required />
          <select name="questionType" onchange="render()">
            <option value="short_text">Short text answer</option>
            <option value="multiple_response">Multiple-response checkbox</option>
          </select>
          <input name="expectedWordCount" type="number" min="1" max="4" value="1" />
        </div>
        <textarea name="questionText" placeholder="Question text" required></textarea>
        <input name="imageUrl" placeholder="Optional image URL" />
        <input name="correctAnswer" placeholder="Correct answer for short text questions" />
        <textarea name="options" placeholder="Checkbox options, one per line. Prefix correct options with *&#10;*Pattern discovery&#10;Video game console"></textarea>
        <textarea name="explanation" placeholder="Optional explanation shown after correct answer"></textarea>
        <button>Add question</button>
      </form>
      ${state.adminData.days.map(day => html`
        <section class="stack">
          <h2>Day ${day.day_number}: ${escapeHtml(day.title)}</h2>
          ${(day.questions || []).map(question => html`
            <form class="card stack" onsubmit="saveExistingQuestion(event, ${question.id})">
              <div class="row between">
                <strong>#${question.question_order} · ${escapeHtml(question.question_type)}</strong>
                <button class="secondary" type="button" onclick="deleteQuestion(${question.id})">Delete</button>
              </div>
              <div class="form-grid">
                <select name="dayId">${state.adminData.days.map(item => `<option value="${item.id}" ${item.id === question.day_id ? "selected" : ""}>Day ${item.day_number}</option>`).join("")}</select>
                <input name="questionOrder" type="number" min="1" value="${question.question_order}" required />
                <select name="questionType">
                  <option value="short_text" ${question.question_type === "short_text" ? "selected" : ""}>Short text answer</option>
                  <option value="multiple_response" ${question.question_type === "multiple_response" ? "selected" : ""}>Multiple-response checkbox</option>
                </select>
                <input name="expectedWordCount" type="number" min="1" max="4" value="${question.expected_word_count || 1}" />
              </div>
              <textarea name="questionText" required>${escapeHtml(question.question_text)}</textarea>
              <input name="imageUrl" value="${escapeHtml(question.image_url || "")}" placeholder="Optional image URL" />
              <input name="correctAnswer" value="${escapeHtml(question.correct_answer || "")}" placeholder="Correct answer for short text questions" />
              <textarea name="options" placeholder="Checkbox options, one per line. Prefix correct options with *">${escapeHtml(optionsToText(question.options || []))}</textarea>
              <textarea name="explanation" placeholder="Optional explanation">${escapeHtml(question.explanation || "")}</textarea>
              <button>Save question</button>
            </form>
          `).join("")}
        </section>
      `).join("")}
    </section>
  `;
}

function optionsToText(options) {
  return options.map(option => `${option.is_correct ? "*" : ""}${option.option_text}`).join("\n");
}

async function createParticipant(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  await api("/api/admin/participants", {
    method: "POST",
    body: JSON.stringify({ userId: form.get("userId"), name: form.get("name") })
  });
  await loadAdminData();
  state.message = "Participant saved.";
  render();
}

async function resetStudentProgress(userId, dayId = null) {
  const scope = dayId ? "this day for this student" : "all days for this student";
  if (!confirm(`Reset ${scope}? This clears attempts and progress so testing can start again.`)) return;
  await api("/api/admin/reset-progress", {
    method: "POST",
    body: JSON.stringify({ userId, dayId })
  });
  await loadAdminData();
  state.message = "Session progress reset.";
  render();
}

async function resetAllProgress() {
  if (!confirm("Reset all sessions for all students? This clears every attempt and progress record.")) return;
  await api("/api/admin/reset-progress", { method: "POST", body: JSON.stringify({}) });
  await loadAdminData();
  state.message = "All sessions reset.";
  render();
}

async function updateParticipant(id) {
  await api(`/api/admin/participants/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      userId: document.querySelector(`#uid-${id}`).value,
      name: document.querySelector(`#name-${id}`).value,
      isActive: document.querySelector(`#active-${id}`).checked
    })
  });
  await loadAdminData();
  state.message = "Participant updated.";
  render();
}

async function deleteParticipant(id) {
  if (!confirm("Delete this participant and their progress?")) return;
  await api(`/api/admin/participants/${id}`, { method: "DELETE" });
  await loadAdminData();
  render();
}

async function updateDay(event, id) {
  event.preventDefault();
  const form = new FormData(event.target);
  await api(`/api/admin/days/${id}`, {
    method: "PUT",
    body: JSON.stringify({ title: form.get("title"), description: form.get("description"), isActive: Boolean(form.get("isActive")) })
  });
  await loadAdminData();
  state.message = "Day updated.";
  render();
}

async function saveQuestion(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const options = String(form.get("options") || "").split("\n").map(line => line.trim()).filter(Boolean).map(line => ({
    optionText: line.startsWith("*") ? line.slice(1).trim() : line,
    isCorrect: line.startsWith("*")
  }));
  await api("/api/admin/questions", {
    method: "POST",
    body: JSON.stringify({
      dayId: Number(form.get("dayId")),
      questionOrder: Number(form.get("questionOrder")),
      questionType: form.get("questionType"),
      questionText: form.get("questionText"),
      imageUrl: form.get("imageUrl"),
      correctAnswer: form.get("correctAnswer"),
      expectedWordCount: Number(form.get("expectedWordCount")),
      explanation: form.get("explanation"),
      options
    })
  });
  await loadAdminData();
  state.message = "Question added.";
  render();
}

async function saveExistingQuestion(event, id) {
  event.preventDefault();
  const form = new FormData(event.target);
  const options = String(form.get("options") || "").split("\n").map(line => line.trim()).filter(Boolean).map(line => ({
    optionText: line.startsWith("*") ? line.slice(1).trim() : line,
    isCorrect: line.startsWith("*")
  }));
  await api(`/api/admin/questions/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      dayId: Number(form.get("dayId")),
      questionOrder: Number(form.get("questionOrder")),
      questionType: form.get("questionType"),
      questionText: form.get("questionText"),
      imageUrl: form.get("imageUrl"),
      correctAnswer: form.get("correctAnswer"),
      expectedWordCount: Number(form.get("expectedWordCount")),
      explanation: form.get("explanation"),
      options
    })
  });
  await loadAdminData();
  state.message = "Question updated.";
  render();
}

async function deleteQuestion(id) {
  if (!confirm("Delete this question and related attempts?")) return;
  await api(`/api/admin/questions/${id}`, { method: "DELETE" });
  await loadAdminData();
  render();
}

async function logoutAdmin() {
  await api("/api/admin/logout", { method: "POST" });
  state.admin = null;
  setView("admin-login");
}

if (state.participant) {
  studentHome();
} else {
  render();
}
