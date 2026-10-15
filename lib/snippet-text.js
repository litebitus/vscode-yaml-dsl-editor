function snippetTextOf(text) {
  return String(text).replace(/[$}\\]/g, '\\$&');
}

function snippetChoiceOf(text) {
  return String(text).replace(/[$}\\,|]/g, '\\$&');
}

module.exports = { snippetTextOf, snippetChoiceOf };
