const { textHashOf } = require('./text-hash');

const APPLIED_FILE_STATES_CAPACITY = 256;

function createSuggestionUndoSaves({ logError = console.error } = {}) {
  const appliedFileStates = [];
  const undoneTextHashByUri = new Map();

  function recordApply(files) {
    appliedFileStates.push(...files);
    appliedFileStates.splice(0, Math.max(0, appliedFileStates.length - APPLIED_FILE_STATES_CAPACITY));
  }

  function landsOnAppliedState(uri, textHash) {
    return appliedFileStates.some((state) => state.uri === uri
      && (state.textHashBefore === textHash || state.textHashAfter === textHash));
  }

  async function documentChanged(document, changedByUndoOrRedo) {
    const uri = document.uri.toString();
    if (changedByUndoOrRedo) {
      if (!appliedFileStates.some((state) => state.uri === uri)) return false;
      const textHash = textHashOf(document.getText());
      if (landsOnAppliedState(uri, textHash)) undoneTextHashByUri.set(uri, textHash);
      else undoneTextHashByUri.delete(uri);
    }
    if (!undoneTextHashByUri.has(uri) || !document.isDirty) return false;
    const undoneTextHash = undoneTextHashByUri.get(uri);
    undoneTextHashByUri.delete(uri);
    if (textHashOf(document.getText()) !== undoneTextHash) return false;
    try {
      return await document.save();
    } catch (error) {
      const reason = error && error.message ? error.message : error;
      logError(`saving ${document.uri.toString()} after an undo or redo failed: ${reason}`);
      return false;
    }
  }

  return { recordApply, documentChanged };
}

module.exports = { APPLIED_FILE_STATES_CAPACITY, createSuggestionUndoSaves };
