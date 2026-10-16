const zlib = require('zlib');

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const STORED = 0;
const DEFLATED = 8;

function endOfCentralDirectoryOffset(zip) {
  for (let offset = zip.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  throw new Error('the file is not a zip: it has no end of central directory record');
}

function entryDataOf(zip, localHeaderOffset, compressedSize, method, name) {
  if (zip.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`the zip entry ${name} has no local header`);
  }
  const dataOffset = localHeaderOffset
    + 30
    + zip.readUInt16LE(localHeaderOffset + 26)
    + zip.readUInt16LE(localHeaderOffset + 28);
  const data = zip.subarray(dataOffset, dataOffset + compressedSize);
  if (method === STORED) return data;
  if (method === DEFLATED) return zlib.inflateRawSync(data);
  throw new Error(`the zip entry ${name} uses compression method ${method}, which is not read`);
}

function zipEntriesOf(zip) {
  const directoryEnd = endOfCentralDirectoryOffset(zip);
  const entryCount = zip.readUInt16LE(directoryEnd + 10);
  let offset = zip.readUInt32LE(directoryEnd + 16);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('the zip central directory is broken');
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name.endsWith('/')) {
      entries.push({ name, data: entryDataOf(zip, localHeaderOffset, compressedSize, method, name) });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

module.exports = { zipEntriesOf };
