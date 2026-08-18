function firstDefined(object, keys) {
  for (const key of keys) if (object?.[key] !== undefined) return object[key];
}

function questionArray(document, dayNumber) {
  if (Array.isArray(document)) return document;
  const direct = firstDefined(document, ["questions", "quizQuestions", "quiz_questions"]);
  if (Array.isArray(direct)) return direct;
  const day = document?.[`day${dayNumber}`] || document?.[`day_${dayNumber}`] || document?.days?.[dayNumber - 1];
  if (Array.isArray(day)) return day;
  if (Array.isArray(day?.questions)) return day.questions;
  throw new Error("JSON must contain a questions array.");
}

function normalizeQuizDocument(document, dayNumber) {
  const rows = questionArray(document, dayNumber);
  if (!rows.length) throw new Error("The JSON file does not contain any questions.");
  return rows.map((row, index) => {
    if (!row || typeof row !== "object") throw new Error(`Question ${index + 1} must be an object.`);
    const text = firstDefined(row, ["questionText", "question_text", "question", "text", "prompt"]);
    if (!String(text || "").trim()) throw new Error(`Question ${index + 1} has no question text.`);
    const rawOptions = firstDefined(row, ["options", "answers", "choices"]);
    const correctValue = firstDefined(row, ["correctAnswer", "correct_answer", "correctAnswers", "correct_answers", "answer"]);
    const correct = Array.isArray(correctValue) ? correctValue : correctValue == null ? [] : [correctValue];
    const options = Array.isArray(rawOptions) ? rawOptions.map((option, optionIndex) => {
      const optionText = String(typeof option === "string" ? option : firstDefined(option, ["optionText", "option_text", "text", "label", "value"]) || "").trim();
      const explicit = typeof option === "object" && option ? firstDefined(option, ["isCorrect", "is_correct", "correct"]) : undefined;
      const usesZeroBasedIndexes = correct.some(value => Number(value) === 0);
      const isCorrect = explicit === undefined ? correct.some(value => {
        if (typeof value === "number") return value === (usesZeroBasedIndexes ? optionIndex : optionIndex + 1);
        const normalized = String(value).trim().toLowerCase();
        return normalized === optionText.toLowerCase() || normalized === String.fromCharCode(97 + optionIndex);
      }) : Boolean(explicit);
      return { optionText, isCorrect };
    }) : [];
    if (options.some(option => !option.optionText)) throw new Error(`Question ${index + 1} contains an option with no text.`);
    const requestedType = firstDefined(row, ["questionType", "question_type", "type"]);
    const type = options.length || ["multiple_response", "multiple_choice", "checkbox"].includes(requestedType) ? "multiple_response" : "short_text";
    if (type === "multiple_response" && (!options.length || !options.some(option => option.isCorrect))) throw new Error(`Question ${index + 1} must have options and at least one correct option.`);
    const shortAnswer = type === "short_text" ? String(correct[0] ?? "").trim() : null;
    if (type === "short_text" && !shortAnswer) throw new Error(`Question ${index + 1} has no correct answer.`);
    return {
      questionOrder: Number(firstDefined(row, ["questionOrder", "question_order", "order"])) || index + 1,
      questionType: type, questionText: String(text).trim(),
      imageUrl: String(firstDefined(row, ["imageUrl", "image_url", "image"]) || "").trim(),
      correctAnswer: shortAnswer,
      expectedWordCount: type === "short_text" ? Number(firstDefined(row, ["expectedWordCount", "expected_word_count"])) || shortAnswer.split(/\s+/).length : null,
      explanation: String(firstDefined(row, ["explanation", "feedback", "rationale"]) || "").trim(), options
    };
  });
}

module.exports = { normalizeQuizDocument };
