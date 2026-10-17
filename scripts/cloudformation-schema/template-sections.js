const { orIntrinsicFunction } = require('./provider-schemas');

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

function argument(name, type, description, { required = true, repeated = false } = {}) {
  return { name, type, required, repeated, description };
}

const INTRINSIC_FUNCTION_TABLE = {
  Base64: {
    description: 'Returns the Base64 representation of the input string.',
    arguments: [argument('text', 'text', 'The text to encode.')],
    return: { type: 'text', description: 'The text in Base64.' },
  },
  Cidr: {
    description: 'Divides an IP block into CIDR address blocks.',
    arguments: [
      argument('ip_block', 'text', 'The CIDR block to divide, such as `10.0.0.0/16`.'),
      argument('count', 'any', 'How many CIDR blocks to make, `1` to `256`.'),
      argument('cidr_bits', 'any', 'The host bits of each block: `32` minus its prefix length for IPv4, `128` for IPv6.'),
    ],
    return: { type: 'list', description: 'The CIDR blocks.' },
  },
  FindInMap: {
    description: 'Returns the value at two keys of a map declared in the `Mappings` section.',
    arguments: [
      argument('map_name', 'text', 'The map\'s name in `Mappings`.'),
      argument('top_level_key', 'text', 'The key in the map.'),
      argument('second_level_key', 'text', 'The key under the top-level key.'),
      argument(
        'default',
        'map',
        '`{ DefaultValue: <value> }`, returned where the keys find nothing. Needs the `AWS::LanguageExtensions` transform.',
        { required: false },
      ),
    ],
    return: { type: 'any', description: 'The value at the two keys.' },
  },
  GetAtt: {
    description: 'Returns the value of an attribute of a resource in the template.',
    arguments: [
      argument('logical_id', 'text', 'The resource\'s logical ID, or `<logicalId>.<attribute>` written as one value.'),
      argument('attribute', 'text', 'The attribute\'s name.', { required: false }),
    ],
    return: { type: 'any', description: 'The attribute\'s value.' },
  },
  GetAZs: {
    description: 'Returns the Availability Zones of a Region in alphabetical order.',
    arguments: [argument('region', 'text', 'The Region; `""` reads the stack\'s own.')],
    return: { type: 'list', description: 'The Availability Zones.' },
  },
  GetStackOutput: {
    description: 'Returns the value of an output of another stack, in this or another account or Region.',
    arguments: [
      argument('output', 'map', '`StackName` and `OutputName`, with `Region` and `RoleArn` where the stack is elsewhere.'),
    ],
    return: { type: 'any', description: 'The output\'s value.' },
  },
  If: {
    description: 'Returns one of two values by a condition.',
    arguments: [
      argument('condition', 'text', 'The condition\'s name in the `Conditions` section.'),
      argument('value_if_true', 'any', 'The value where the condition is true.'),
      argument('value_if_false', 'any', 'The value where the condition is false; `!Ref AWS::NoValue` leaves the property out.'),
    ],
    return: { type: 'any', description: 'The value the condition selects.' },
  },
  ImportValue: {
    description: 'Returns the value of an output another stack exports.',
    arguments: [argument('export_name', 'text', 'The name the value is exported under.')],
    return: { type: 'any', description: 'The exported value.' },
  },
  Join: {
    description: 'Joins a list of values into one value, separated by the delimiter.',
    arguments: [
      argument('delimiter', 'text', 'The text between the values; `""` joins them with nothing.'),
      argument('values', 'list', 'The values to join.'),
    ],
    return: { type: 'text', description: 'The joined text.' },
  },
  Length: {
    description: 'Returns the number of elements of a list. Needs the `AWS::LanguageExtensions` transform.',
    arguments: [argument('items', 'list', 'The list to count.')],
    return: { type: 'whole_number', description: 'The number of elements.' },
  },
  Select: {
    description: 'Returns the item of a list at an index.',
    arguments: [
      argument('index', 'any', 'The item\'s position, from `0`.'),
      argument('values', 'list', 'The list to select from.'),
    ],
    return: { type: 'any', description: 'The item at the index.' },
  },
  Split: {
    description: 'Splits a string into a list of strings at the delimiter.',
    arguments: [
      argument('delimiter', 'text', 'The text to split at.'),
      argument('source', 'text', 'The text to split.'),
    ],
    return: { type: 'list', description: 'The pieces, in order.' },
  },
  Sub: {
    description: 'Substitutes the `${...}` variables in a string.',
    arguments: [
      argument('template', 'text', 'The text whose variables are substituted; `${!...}` stays literal.'),
      argument(
        'variables',
        'map',
        'Variable name to value, for the names the template uses beyond parameters, resources and pseudo parameters.',
        { required: false },
      ),
    ],
    return: { type: 'text', description: 'The text with its variables substituted.' },
  },
  ToJsonString: {
    description: 'Converts an object or a list to its JSON string. Needs the `AWS::LanguageExtensions` transform.',
    arguments: [argument('value', 'any', 'The object or list to convert.')],
    return: { type: 'text', description: 'The JSON string.' },
  },
  Transform: {
    description: 'Calls a macro to process part of the template.',
    arguments: [argument('macro', 'map', 'The macro\'s `Name` and its `Parameters`.')],
    return: { type: 'any', description: 'What the macro returns in place of the call.' },
  },
};

const CONDITION_FUNCTION_TABLE = {
  And: {
    description: 'Is true when every one of its 2 to 10 conditions is true.',
    arguments: [
      argument('first', 'any', 'A condition function, or `Condition: <name>`.'),
      argument('second', 'any', 'A condition function, or `Condition: <name>`.'),
      argument('more', 'any', 'Further conditions, up to 10 in all.', { required: false, repeated: true }),
    ],
    return: { type: 'boolean', description: '`true` when every condition is true.' },
  },
  Equals: {
    description: 'Is true when its two values are equal.',
    arguments: [
      argument('value', 'any', 'The first value.'),
      argument('other_value', 'any', 'The value compared with it.'),
    ],
    return: { type: 'boolean', description: '`true` when the values are equal.' },
  },
  Not: {
    description: 'Is true when its one condition is false.',
    arguments: [argument('condition', 'list', 'A list holding the one condition to negate.')],
    return: { type: 'boolean', description: '`true` when the condition is false.' },
  },
  Or: {
    description: 'Is true when any one of its 2 to 10 conditions is true.',
    arguments: [
      argument('first', 'any', 'A condition function, or `Condition: <name>`.'),
      argument('second', 'any', 'A condition function, or `Condition: <name>`.'),
      argument('more', 'any', 'Further conditions, up to 10 in all.', { required: false, repeated: true }),
    ],
    return: { type: 'boolean', description: '`true` when any condition is true.' },
  },
};

function callKeysOf(functionTable) {
  return Object.fromEntries(Object.keys(functionTable).map((name) => [`${FUNCTION_CALL_MARKER}${name}`, {}]));
}

const INTRINSIC_FUNCTIONS = {
  Ref: {
    description: 'Returns the value of the specified parameter or resource.',
    type: 'string',
  },
  ...callKeysOf(INTRINSIC_FUNCTION_TABLE),
  'Fn::Transform': {
    description: 'A macro call; `Name: AWS::Include` includes the snippet at `Parameters.Location` in its place.',
    anyOf: [transformValue, { type: 'array', items: transformValue }],
  },
};

const CONDITION_FUNCTIONS = {
  ...callKeysOf(CONDITION_FUNCTION_TABLE),
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
    functions: { ...INTRINSIC_FUNCTION_TABLE, ...CONDITION_FUNCTION_TABLE },
  };
}

module.exports = { TEMPLATE_FORMAT_VERSION, templateSectionsOf };
