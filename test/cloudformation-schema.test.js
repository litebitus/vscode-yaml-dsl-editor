const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { schemaValidatorFor, schemaParserForDocument } = require('../lib/json-schema');
const { unicodePatternOf } = require('../scripts/cloudformation-schema/regex-patterns');
const { zipEntriesOf } = require('../scripts/cloudformation-schema/zip-entries');
const { resourceTypeDefinitionOf } = require('../scripts/cloudformation-schema/provider-schemas');
const { templateSchemaOf } = require('../scripts/cloudformation-schema/template-schema');

const MOCK_ZIP = path.join(__dirname, 'fixtures', 'cloudformation-schema', 'mock-providers.zip');
const INTRINSIC_FUNCTION = { $ref: '#/$defs/IntrinsicFunction' };

function mockProviders() {
  return zipEntriesOf(fs.readFileSync(MOCK_ZIP)).map((entry) => JSON.parse(entry.data.toString('utf8')));
}

function mockProvider(typeName) {
  return mockProviders().find((provider) => provider.typeName === typeName);
}

function mockTemplateValidator() {
  const { schema } = templateSchemaOf(mockProviders(), { region: 'mock-region-1', downloadDate: '2026-01-01' });
  return schemaValidatorFor(schema);
}

function failureKeywordsOf(validator, template) {
  return validator.documentFailures(template).map(({ path: failurePath, keyword }) => [failurePath.join('.'), keyword]);
}

test('a zip\'s stored and deflated entries are read, and its folders are not entries', () => {
  const entries = zipEntriesOf(fs.readFileSync(MOCK_ZIP));
  assert.deepEqual(entries.map((entry) => entry.name), [
    'providers/aws-mock-queue.json',
    'providers/aws-mock-bucket.json',
  ]);
  assert.deepEqual(mockProviders().map((provider) => provider.typeName), ['AWS::Mock::Queue', 'AWS::Mock::Bucket']);
  assert.throws(() => zipEntriesOf(Buffer.from('mock-not-a-zip-at-all-mock-not-a-zip')), /not a zip/);
});

test('a pattern the u flag reads is kept, one with identity escapes loses them, '
  + 'and an unreadable one is left out', () => {
  assert.deepEqual(unicodePatternOf('^\\p{L}+$'), { pattern: '^\\p{L}+$', problem: null });
  assert.deepEqual(unicodePatternOf('^[a-z\\:]+\\@mock$'), { pattern: '^[a-z:]+@mock$', problem: null });
  assert.deepEqual(unicodePatternOf('^[\\w\\-\\:]+$'), { pattern: '^[\\w\\-:]+$', problem: null });
  assert.deepEqual(unicodePatternOf('^\\[mock\\]\\.\\\\$'), { pattern: '^\\[mock\\]\\.\\\\$', problem: null });
  const javaFlags = unicodePatternOf('(?s).+');
  assert.equal(javaFlags.pattern, null);
  assert.equal(typeof javaFlags.problem, 'string');
});

test('a resource type keeps its writable properties, each value also taking an intrinsic function', () => {
  const leftOutPatterns = [];
  const definition = resourceTypeDefinitionOf(mockProvider('AWS::Mock::Bucket'), leftOutPatterns);
  assert.deepEqual(Object.keys(definition.properties), ['BucketName', 'Rules', 'SourceArn', 'LegacyName']);
  assert.deepEqual(definition.required, ['BucketName']);
  assert.equal(definition.additionalProperties, false);
  assert.deepEqual(definition.properties.Rules, {
    anyOf: [
      {
        type: 'array',
        items: {
          anyOf: [{ $ref: '#/$defs/AWS::Mock::Bucket/$defs/MockRule' }, INTRINSIC_FUNCTION],
        },
      },
      INTRINSIC_FUNCTION,
    ],
  });
  assert.deepEqual(definition.properties.LegacyName, {
    description: 'The old mock name.',
    anyOf: [{ type: 'string' }, INTRINSIC_FUNCTION],
    deprecated: true,
  });
  assert.deepEqual(definition.properties.SourceArn, {
    description: 'The mock ARN.',
    anyOf: [{ type: 'string' }, INTRINSIC_FUNCTION],
  });
  assert.deepEqual(definition.$defs.MockRule.properties.Prefix, {
    description: 'The mock prefix.',
    anyOf: [{ type: 'string', pattern: '^[a-z:]+$' }, INTRINSIC_FUNCTION],
  });
  assert.deepEqual(leftOutPatterns.map(({ typeName, where, pattern }) => [typeName, where, pattern]), [
    ['AWS::Mock::Bucket', '/properties/BucketName/pattern', '(?s).+'],
  ]);
});

test('the template schema states its source and gives each resource the properties of its Type', () => {
  const { schema } = templateSchemaOf(mockProviders(), { region: 'mock-region-1', downloadDate: '2026-01-01' });
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.match(schema.$comment, /of mock-region-1, downloaded 2026-01-01\.$/);
  assert.deepEqual(Object.keys(schema.$defs).filter((key) => key.startsWith('AWS::')), [
    'AWS::Mock::Bucket',
    'AWS::Mock::Queue',
  ]);
  const validator = mockTemplateValidator();
  assert.deepEqual(failureKeywordsOf(validator, {
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {
      MockBucket: {
        Type: 'AWS::Mock::Bucket',
        Properties: { BucketName: { Ref: 'MockName' }, Rules: [{ Prefix: 'mock:logs', Days: 1 }] },
        DeletionPolicy: 'Retain',
      },
      MockQueue: { Type: 'AWS::Mock::Queue', Properties: { DelaySeconds: { 'Fn::If': ['MockOn', 1, 2] } } },
      MockCustom: { Type: 'Custom::MockThing', Properties: { MockAnything: 1 } },
      MockRegistry: { Type: 'MockOrg::Mock::Thing' },
    },
  }), []);
  assert.deepEqual(failureKeywordsOf(validator, {
    Resources: {
      MockBucket: { Type: 'AWS::Mock::Bucket', Properties: { Arn: 'mock-arn', Rules: [{ Days: 0 }] } },
      MockQueue: { Type: 'AWS::Mock::Queue', Properties: { DelaySeconds: 901 } },
      MockMissing: { Type: 'AWS::Mock::Missing' },
      MockBare: { Type: 'AWS::Mock::Bucket' },
    },
  }), [
    ['Resources.MockBucket.Properties', 'required'],
    ['Resources.MockBucket.Properties', 'additionalProperties'],
    ['Resources.MockBucket.Properties.Rules', 'anyOf'],
    ['Resources.MockQueue.Properties.DelaySeconds', 'anyOf'],
    ['Resources.MockMissing.Type', 'anyOf'],
    ['Resources.MockBare', 'required'],
  ]);
});

test('a resource\'s Type selects its service\'s branch and then its type\'s, for validation, fields and hover', () => {
  const mockTopic = {
    typeName: 'AWS::MockOther::Topic',
    description: 'A mock topic.',
    additionalProperties: false,
    properties: { TopicName: { description: 'The mock topic name.', type: 'string' } },
  };
  const { schema } = templateSchemaOf([...mockProviders(), mockTopic], {
    region: 'mock-region-1',
    downloadDate: '2026-01-01',
  });
  assert.deepEqual(schema.$defs.Resource.allOf.map((branch) => [
    branch.if.properties.Type.pattern,
    branch.then.allOf.map((typeBranch) => typeBranch.if.properties.Type.const),
  ]), [
    ['^AWS::Mock::', ['AWS::Mock::Bucket', 'AWS::Mock::Queue']],
    ['^AWS::MockOther::', ['AWS::MockOther::Topic']],
  ]);
  const template = {
    Resources: {
      MockBucket: { Type: 'AWS::Mock::Bucket', Properties: { BucketName: 'mock-bucket' } },
      MockQueue: { Type: 'AWS::Mock::Queue', Properties: {} },
      MockTopic: { Type: 'AWS::MockOther::Topic', Properties: { BucketName: 'mock-bucket' } },
    },
  };
  assert.deepEqual(failureKeywordsOf(schemaValidatorFor(schema), template), [
    ['Resources.MockTopic.Properties', 'additionalProperties'],
  ]);
  const parser = schemaParserForDocument(schema, template);
  const fieldNamesAt = (logicalId) => Object.keys(parser.fieldsAt(['Resources', logicalId, 'Properties']));
  assert.deepEqual(fieldNamesAt('MockBucket'), ['BucketName', 'Rules', 'SourceArn', 'LegacyName']);
  assert.deepEqual(fieldNamesAt('MockQueue'), ['DelaySeconds']);
  assert.deepEqual(fieldNamesAt('MockTopic'), ['TopicName']);
  assert.deepEqual(parser.requiredKeysAt(['Resources', 'MockBucket']), ['Type', 'Properties']);
  assert.deepEqual(parser.requiredKeysAt(['Resources', 'MockTopic']), ['Type']);
  assert.equal(parser.fieldDescription(['Resources', 'MockTopic', 'Properties', 'TopicName']), 'The mock topic name.');
  assert.equal(parser.fieldDescription(['Resources', 'MockBucket', 'Properties', 'TopicName']), null);
});

test('the template sections hold the version, parameters, outputs and intrinsic functions '
  + 'as CloudFormation states them', () => {
  const validator = mockTemplateValidator();
  assert.deepEqual(failureKeywordsOf(validator, {
    Parameters: { MockName: { Type: 'String', Default: 'mock-name' } },
    Conditions: { MockOn: { 'Fn::Equals': [{ Ref: 'MockName' }, 'mock-name'] } },
    Resources: { MockQueue: { Type: 'AWS::Mock::Queue' } },
    Outputs: { MockOut: { Value: { 'Fn::GetAtt': ['MockQueue', 'Arn'] }, Export: { Name: 'mock-export' } } },
  }), []);
  assert.deepEqual(failureKeywordsOf(validator, {
    AWSTemplateFormatVersion: '2000-01-01',
    Parameters: { MockName: { Default: 'mock-name' } },
    Resources: { 'mock-queue': { Type: 'AWS::Mock::Queue' } },
    Outputs: { MockOut: { Description: 'mock' } },
    MockSection: {},
  }), [
    ['', 'additionalProperties'],
    ['AWSTemplateFormatVersion', 'const'],
    ['Parameters.MockName', 'required'],
    ['Resources', 'additionalProperties'],
    ['Outputs.MockOut', 'required'],
  ]);
  assert.deepEqual(failureKeywordsOf(validator, {}), [['', 'required']]);
});
