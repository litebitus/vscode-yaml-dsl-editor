const { orIntrinsicFunction } = require('./provider-schemas');
const { 'x-yaml-dsl-functions': FUNCTION_TABLE } = require('../../examples/schemas/cloudformation-functions.json');

const TEMPLATE_FORMAT_VERSION = '2010-09-09';
const LOGICAL_ID_PATTERN = '^[A-Za-z0-9]+$';
const FOR_EACH_KEY_PATTERN = '^Fn::ForEach::[A-Za-z0-9]+$';
const CUSTOM_RESOURCE_TYPE_PATTERN = '^Custom::[A-Za-z0-9_@-]{1,60}$';
const REGISTRY_RESOURCE_TYPE_PATTERN = '^(?!AWS::|Alexa::)'
  + '[A-Za-z0-9]{2,64}::[A-Za-z0-9]{2,64}::[A-Za-z0-9]{2,64}(::MODULE)?$';

const conditionFunction = { $ref: '#/$defs/ConditionFunction' };
const transformValue = { $ref: '#/$defs/Transform' };
const forEachLoop = { $ref: '#/$defs/ForEach' };
const anyValue = { $ref: '#/$defs/AnyValue' };
const stringOrFunction = orIntrinsicFunction({ type: 'string' });
const listOrFunction = orIntrinsicFunction({ type: 'array' });

function exactlyOneKey(properties, description) {
  return {
    description,
    type: 'object',
    minProperties: 1,
    maxProperties: 1,
    properties,
    additionalProperties: false,
  };
}

const FUNCTION_CALL_MARKER = 'Fn::';
const CONDITION_FUNCTION_NAMES = ['And', 'Equals', 'Not', 'Or'];
const KEY_MACRO_KINDS = ['loop', 'merge'];
const INTRINSIC_FUNCTION_NAMES = Object.entries(FUNCTION_TABLE)
  .filter(([name, entry]) => !CONDITION_FUNCTION_NAMES.includes(name)
    && !(entry.macro && KEY_MACRO_KINDS.includes(entry.macro.kind)))
  .map(([name]) => name);

function callKeysOf(functionNames) {
  return Object.fromEntries(functionNames.map((name) => [`${FUNCTION_CALL_MARKER}${name}`, {}]));
}

const INTRINSIC_FUNCTIONS = {
  Ref: {
    description: 'Returns the value of the specified parameter or resource.',
    type: 'string',
  },
  ...callKeysOf(INTRINSIC_FUNCTION_NAMES),
  'Fn::Transform': {
    description: 'A macro call; `Name: AWS::Include` includes the snippet at `Parameters.Location` in its place.',
    anyOf: [transformValue, { type: 'array', items: transformValue }],
  },
};

const CONDITION_FUNCTIONS = {
  ...callKeysOf(CONDITION_FUNCTION_NAMES),
  Condition: {
    description: 'The condition of that name in the Conditions section.',
    type: 'string',
  },
};

const RESOURCE_ATTRIBUTES = {
  Condition: {
    description: 'The condition, in the Conditions section, that decides whether the resource is created.',
    type: 'string',
  },
  CreationPolicy: {
    description: 'Holds the resource\'s creation status until CloudFormation receives its success signals '
      + 'or the timeout passes.',
    type: 'object',
  },
  DeletionPolicy: {
    description: 'What CloudFormation does with the resource when it is deleted from the stack; Delete by default.',
    ...orIntrinsicFunction({ enum: ['Delete', 'Retain', 'RetainExceptOnCreate', 'Snapshot'] }),
  },
  DependsOn: {
    description: 'The resources created before this one.',
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, uniqueItems: true }],
  },
  Metadata: {
    description: 'Structured data associated with the resource.',
    type: 'object',
  },
  UpdatePolicy: {
    description: 'How CloudFormation updates the resource.',
    type: 'object',
  },
  UpdateReplacePolicy: {
    description: 'What CloudFormation does with the old resource when an update replaces it; Delete by default.',
    ...orIntrinsicFunction({ enum: ['Delete', 'Retain', 'Snapshot'] }),
  },
};

const PARAMETER = {
  description: 'An input value given when a stack is created or updated.',
  type: 'object',
  required: ['Type'],
  additionalProperties: false,
  properties: {
    Type: {
      description: 'The data type of the parameter: String, Number, List<Number>, CommaDelimitedList, '
        + 'an AWS-specific parameter type or a Systems Manager parameter type.',
      type: 'string',
    },
    AllowedPattern: {
      description: 'A regular expression a String value, or each value of a CommaDelimitedList, must match.',
      type: 'string',
    },
    AllowedValues: {
      description: 'The values a String value, or each value of a CommaDelimitedList, must be one of.',
      type: 'array',
    },
    ConstraintDescription: { description: 'The message shown when a constraint is violated.', type: 'string' },
    Default: { description: 'The value used when the stack is given none.' },
    Description: { description: 'A description of up to 4000 characters.', type: 'string', maxLength: 4000 },
    MaxLength: { description: 'The largest number of characters of a String value.', type: ['integer', 'string'] },
    MaxValue: { description: 'The largest value of a Number value.', type: ['number', 'string'] },
    MinLength: { description: 'The smallest number of characters of a String value.', type: ['integer', 'string'] },
    MinValue: { description: 'The smallest value of a Number value.', type: ['number', 'string'] },
    NoEcho: {
      description: 'Whether the value is masked as asterisks wherever the stack is described.',
      type: ['boolean', 'string'],
    },
  },
};

const OUTPUT = {
  description: 'A value of the stack, returned when its properties are viewed and optionally exported.',
  type: 'object',
  required: ['Value'],
  additionalProperties: false,
  properties: {
    Description: {
      description: 'A literal string of 0 to 1024 bytes describing the output.',
      type: 'string',
      maxLength: 1024,
    },
    Value: { description: 'The value of the output.', ...anyValue },
    Export: {
      description: 'Exports the output for other stacks to import.',
      type: 'object',
      required: ['Name'],
      additionalProperties: false,
      properties: { Name: { description: 'The name the output is exported under.', ...stringOrFunction } },
    },
    Condition: {
      description: 'The condition, in the Conditions section, that decides whether the output is created.',
      type: 'string',
    },
  },
};

const TRANSFORM = {
  description: 'A macro call, by its name and parameters.',
  type: 'object',
  required: ['Name'],
  additionalProperties: false,
  properties: {
    Name: { description: 'The name of the macro, such as AWS::Include.', type: 'string' },
    Parameters: { description: 'The parameters passed to the macro.', type: 'object' },
  },
};

const FOR_EACH = {
  description: 'Repeats a fragment for each item of a collection. Needs the AWS::LanguageExtensions transform.',
  type: 'array',
  prefixItems: [
    { description: 'The identifier replaced by each item in the output key and value.', type: 'string' },
    { description: 'The collection to iterate over.', ...listOrFunction },
    { description: 'The output key and value repeated for each item.', type: 'object' },
  ],
  minItems: 3,
  maxItems: 3,
};

function logicalIdMap(description, entry, extraProperties = {}) {
  return {
    description,
    type: 'object',
    properties: extraProperties,
    patternProperties: { [LOGICAL_ID_PATTERN]: entry, [FOR_EACH_KEY_PATTERN]: forEachLoop },
    additionalProperties: false,
  };
}

function serviceOf(typeName) {
  return typeName.split('::').slice(0, 2).join('::');
}

function typeBranchOf({ typeName, pointer, propertiesRequired }) {
  return {
    if: { properties: { Type: { const: typeName } }, required: ['Type'] },
    then: {
      properties: { Properties: { $ref: pointer } },
      ...(propertiesRequired ? { required: ['Properties'] } : {}),
    },
  };
}

function serviceBranchesOf(resourceTypes) {
  const typesByService = Map.groupBy(resourceTypes, (resourceType) => serviceOf(resourceType.typeName));
  return [...typesByService].map(([service, serviceTypes]) => ({
    if: { properties: { Type: { pattern: `^${service}::` } }, required: ['Type'] },
    then: { allOf: serviceTypes.map(typeBranchOf) },
  }));
}

function resourceDefinitionOf(resourceTypes) {
  return {
    description: 'A resource of the stack.',
    type: 'object',
    required: ['Type'],
    additionalProperties: false,
    properties: {
      Type: {
        description: 'The resource type, such as AWS::S3::Bucket, a custom resource or a registry type.',
        type: 'string',
        anyOf: [
          { enum: resourceTypes.map((resourceType) => resourceType.typeName) },
          { pattern: CUSTOM_RESOURCE_TYPE_PATTERN },
          { pattern: REGISTRY_RESOURCE_TYPE_PATTERN },
        ],
      },
      Properties: { description: 'The properties of the resource, by its type.', type: 'object' },
      ...RESOURCE_ATTRIBUTES,
    },
    allOf: serviceBranchesOf(resourceTypes),
  };
}

function templateSectionsOf(resourceTypes) {
  return {
    sections: {
      AWSTemplateFormatVersion: {
        description: 'The template format version, the only one CloudFormation has.',
        const: TEMPLATE_FORMAT_VERSION,
      },
      Description: {
        description: 'A literal string of 0 to 1024 bytes describing the template.',
        type: 'string',
        maxLength: 1024,
      },
      Metadata: { description: 'Structured data about the template.', type: 'object' },
      Parameters: {
        ...logicalIdMap(
          'Input values given when a stack is created or updated, at most 200.',
          { $ref: '#/$defs/Parameter' },
        ),
        maxProperties: 200,
      },
      Rules: { description: 'Validates the parameters given, alone or together.', type: 'object' },
      Mappings: {
        description: 'Two-level lookup tables, read with Fn::FindInMap.',
        type: 'object',
        additionalProperties: { type: 'object', additionalProperties: { type: 'object' } },
      },
      Conditions: logicalIdMap('Conditions that decide whether resources and outputs are created.', conditionFunction),
      Transform: {
        description: 'The macros that process the whole template, such as AWS::Serverless-2016-10-31 or AWS::Include.',
        anyOf: [
          { type: 'string' },
          transformValue,
          { type: 'array', items: { anyOf: [{ type: 'string' }, transformValue] } },
        ],
      },
      Resources: logicalIdMap('The resources of the stack.', { $ref: '#/$defs/Resource' }, {
        'Fn::Transform': INTRINSIC_FUNCTIONS['Fn::Transform'],
      }),
      Outputs: {
        ...logicalIdMap('Values of the stack, at most 200.', { $ref: '#/$defs/Output' }),
        maxProperties: 200,
      },
      Hooks: { description: 'Hooks that run during stack operations.', type: 'object' },
    },
    definitions: {
      Resource: resourceDefinitionOf(resourceTypes),
      Parameter: PARAMETER,
      Output: OUTPUT,
      Transform: TRANSFORM,
      ForEach: FOR_EACH,
      IntrinsicFunction: exactlyOneKey(INTRINSIC_FUNCTIONS, 'An intrinsic function, whose value is its arguments.'),
      IntrinsicFunctionCall: {
        description: 'A value written as one intrinsic function, by its name.',
        type: 'object',
        minProperties: 1,
        maxProperties: 1,
        propertyNames: { enum: Object.keys(INTRINSIC_FUNCTIONS) },
      },
      ConditionFunction: exactlyOneKey(CONDITION_FUNCTIONS, 'A condition function, whose value is its arguments.'),
      AnyValue: orIntrinsicFunction({ additionalProperties: anyValue, items: anyValue }),
    },
    functions: FUNCTION_TABLE,
  };
}

module.exports = { TEMPLATE_FORMAT_VERSION, templateSectionsOf };
