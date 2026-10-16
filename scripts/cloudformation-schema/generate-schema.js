#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { zipEntriesOf } = require('./zip-entries');
const { templateSchemaOf } = require('./template-schema');
const { TEMPLATE_FORMAT_VERSION } = require('./template-sections');

const DOWNLOAD_MILLISECONDS = 120000;
const SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'examples',
  'schemas',
  `cloudformation-${TEMPLATE_FORMAT_VERSION}.schema.json`,
);

function providerSchemasUrlOf(region) {
  return `https://schema.cloudformation.${region}.amazonaws.com/CloudformationSchema.zip`;
}

async function providerSchemasOf(region) {
  const url = providerSchemasUrlOf(region);
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_MILLISECONDS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return zipEntriesOf(Buffer.from(await response.arrayBuffer()))
    .filter((entry) => entry.name.endsWith('.json'))
    .map((entry) => JSON.parse(entry.data.toString('utf8')));
}

async function main(args) {
  const [region] = args;
  if (!region) {
    console.error('usage: generate-schema.js <region>, such as us-east-1');
    process.exitCode = 1;
    return;
  }
  const providerSchemas = await providerSchemasOf(region);
  const downloadDate = new Date().toISOString().slice(0, 10);
  const { schema, leftOutPatterns } = templateSchemaOf(providerSchemas, { region, downloadDate });
  const text = `${JSON.stringify(schema)}\n`;
  fs.mkdirSync(path.dirname(SCHEMA_PATH), { recursive: true });
  fs.writeFileSync(SCHEMA_PATH, text);
  const megabytes = (Buffer.byteLength(text) / (1024 * 1024)).toFixed(1);
  const written = path.relative(process.cwd(), SCHEMA_PATH);
  console.log(`wrote ${written}: ${providerSchemas.length} resource types, ${megabytes} MB`);
  for (const leftOut of leftOutPatterns) {
    console.log(`left out ${leftOut.typeName} ${leftOut.where}: ${leftOut.pattern} (${leftOut.problem})`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`generate-schema.js: ${error.message}`);
  process.exitCode = 1;
});
