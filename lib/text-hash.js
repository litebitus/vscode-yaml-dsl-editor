const crypto = require('crypto');

function textHashOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = { textHashOf };
