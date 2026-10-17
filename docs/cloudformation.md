# CloudFormation templates

AWS CloudFormation templates written in YAML are the editor's first public DSL. They are notoriously hard to author by hand:

- References are YAML tags such as `!Ref` and `!GetAtt`, plain strings to every other YAML tool.
- A resource's shape hangs on its `Type`, one of well over a thousand.
- The documentation of each property lives on a web page, away from the file.

The DSL is a config like any other. The engine features it needs are generic and designed in the editor's design doc, so later public DSLs use them too.

## CloudFormation in the editor's terms

| CloudFormation | The editor |
|---|---|
| a template | a DSL file |
| a parameter or a resource, by its logical ID | a declaration in the scope `LOGICAL_ID` |
| a pseudo parameter, such as `AWS::Region` | a builtin of `LOGICAL_ID` |
| a condition | a declaration in `CONDITION` |
| `Ref`, `Fn::GetAtt`, `DependsOn`, a `Condition` | a reference |
| `${...}` in `Fn::Sub` | a placeholder |
| an intrinsic function or a condition function | a call, `Fn::` its marker, its value its arguments |
| a YAML short form, such as `!Ref` | a tag key |
| an `AWS::Include` transform | an include, pairing an overlay with its common layer |
| a template that includes a snippet | an overlay |
| a snippet an `AWS::Include` names | a common layer, rooted at the map holding the include |
| a snippet with the templates that include it | a stack |
| the resource provider schemas | the schema |

A CloudFormation stack is what AWS deploys from a template; the editor's stack is the files that compose one document. The doc says "CloudFormation stack" for the former.

## What an author gets

| Feature | In a template |
|---|---|
| references | `!Ref`, `!GetAtt`, `!Condition` and `${...}` in `!Sub`, in the short or the long form, resolve to their declarations: hover shows the declaration, Command-click opens it, completion offers the names, and a name nothing declares is an error |
| includes | an `AWS::Include` snippet in the repo is read in place as the template's common layer: Command-click on its `Location` opens it, and names resolve across the template and its snippets both ways |
| intrinsic functions | each function's arguments are validated, and hover documents the function |
| field documentation | a resource's properties are documented with AWS's own descriptions for its `Type` |
| completion | the properties of the resource's `Type`, the required ones filled on Enter |
| validation | the whole template, against the CloudFormation schema |

A template composes by including snippets, so the DSL's `layers` pair overlays and common layers by `overlay_includes`.

## The DSL config

The config is `examples/cloudformation/yaml-dsl.yml`, its DSL `cloudformation`.

### Files

`file_includes` claims every YAML file under the config's folder, `{config_root}/**/*.yaml` and `{config_root}/**/*.yml`, so a template takes any name.

### Tags

`tag_keys` lists every intrinsic function and condition function with a YAML short form, each tag standing for the function's long-form key: `!Ref` for `Ref`, `!GetAtt` for `Fn::GetAtt`. A template reads the same written in either form.

### Scopes and declarations

| Scope | Declared at | Builtins |
|---|---|---|
| `LOGICAL_ID` | `$.Parameters.*`, `$.Resources.*` | the pseudo parameters, such as `AWS::Region` |
| `CONDITION` | `$.Conditions.*` | |

Parameters and resources share one scope, as `Ref` reads either.

### References

A reference is known by its syntax, and the tag is the syntax:

| Reference | Scope | Written |
|---|---|---|
| a logical ID | `LOGICAL_ID` | `!Ref Name`, or `Ref: Name` |
| a logical ID and its attribute | `LOGICAL_ID` | `!GetAtt Name.Attribute`, or `Fn::GetAtt: Name.Attribute` |
| a logical ID in a placeholder, with or without an attribute | `LOGICAL_ID` | `${Name}`, `${Name.Attribute}` |
| a condition | `CONDITION` | `!Condition Name`, or `Condition: Name` |

A name that only its field marks, such as in `DependsOn`, the first item of `Fn::If` or `Fn::FindInMap`, or `Fn::GetAtt` as a list, is a value the schema validates.

### Placeholders

`${...}` is a placeholder, and `${!...}` is literal text, as `Fn::Sub` reads them.

### Layers

`layers.common_layer_discovery` is `overlay_includes`, and one `overlay_includes` entry reads `AWS::Include`, at the top level as `Transform` and inside a section as `Fn::Transform`:

| Field | Value |
|---|---|
| `key_paths` | `$.Transform`, `$..['Fn::Transform']` |
| `value_conditions` | `Name` is `AWS::Include` |
| `location_path` | `$.Parameters.Location` |
| `location_mappings` | the S3 prefix the repo uploads its snippets to, as `remote`, and the folder it uploads them from, as `local` |

A repo states its own `location_mappings`; no S3 location maps to a folder by default.

### Quoted values

CloudFormation reads a quoted boolean or number as the value it spells, so `validator.allow_quoted_values` is `[boolean, integer, number]`: `Enabled: "true"` validates as `true`, and `Port: "70000"` still fails a maximum of 65535.

### Functions

An intrinsic function or a condition function is a call through `marker_function`, as in any DSL:

| Field | Value |
|---|---|
| `call_marker` | `Fn::`, so `Fn::Join:` and its tag `!Join` call `Join` |
| `calls_without_name_allowed` | `true`: a function's map holds its call alone |
| `splat_operator` | `null`: the function table decides how a value binds the arguments |

The schema publishes the function table, the one home of each function's description, arguments and return. `Ref` and `Condition` are references, not calls, and a `Fn::Transform` naming `AWS::Include` is the include, documented by the schema.

## The schema

### Source

AWS publishes a resource provider schema for every resource type, one zip of JSON schemas per Region. Each holds the type's properties, their descriptions, its required properties and its read-only properties, the attributes `Fn::GetAtt` reads.

The template schema is generated from them. The template's own sections are written from the CloudFormation template reference: the template anatomy, the intrinsic functions and the pseudo parameters.

### Generator

`scripts/cloudformation-schema/`, run by `make cloudformation-schema` with the Region in `CLOUDFORMATION_REGION`, reads one Region's zip and writes `examples/schemas/cloudformation-<format version>.schema.json` in draft 2020-12. Its tests cover each transformation:

| From the provider schemas | In the template schema |
|---|---|
| a resource type | a `$defs` entry holding its properties, its own definitions nested and their references rewritten to them |
| every resource type | `Type` takes one of them, and one `if`/`then` per service, `AWS::<service>`, holds one per type of the service, which gives `Properties` that type's entry |
| a read-only property | left out of `Properties`; it is an attribute, and a reference to it reads its schema in place |
| a deprecated property | marked `deprecated` |
| a property value | an `if` on `IntrinsicFunctionCall`, a map of one intrinsic function's name: then an intrinsic function, else its own schema, so the document selects the branch its fields and errors come from |
| a pattern | kept when the `u` flag reads it, else without its identity escapes; one neither reads is left out and listed when the generator runs |
| a description | carried as written, so hover shows AWS's text |

A value the template reference leaves open, such as an output's `Value`, refers to one shared definition, `AnyValue`: an intrinsic function call at any depth in it stands in for a value.

The generator writes the function table at `#/x-yaml-dsl-functions` from the intrinsic function reference: each intrinsic and condition function with its description, its arguments and its return. `IntrinsicFunction` and `ConditionFunction` name the calls and leave their arguments to the table.

`Type` also takes a custom resource type, `Custom::<name>`, and a registry type, `<organization>::<service>::<resource>`, whose `Properties` the schema leaves open.

The hand-written part covers each top-level section and its entries: `Parameters` with their types and constraints, `Mappings`, `Conditions` built from condition functions, `Resources` with their resource attributes such as `DependsOn`, `Condition` and `DeletionPolicy`, and `Outputs` with `Value`, `Export` and `Condition`.

### Where it lives

The schema is `examples/schemas/cloudformation-<format version>.schema.json`, beside every other public DSL's schema. `schema_search_paths` names it once, through `{config_root}`, for a template at any depth.

### Versions

- `AWSTemplateFormatVersion` is the template's grammar version, as a DSL's schema version is, and the schema is versioned to match it.
- The editor supports the latest format version only, and the schema's `AWSTemplateFormatVersion` takes that version alone.
- CloudFormation grows by adding resource types, each namespaced `AWS::<service>::<resource>`, and changing their schemas, all under the same format version. The generator writes the latest of them into the same file.
- AWS publishes no versions of the provider schemas, so the schema's `$comment` states the Region and the date the generator downloaded them: the schema is current as of that date. The schema is committed; the generator only writes it.

## Examples

`examples/` is a workspace a user opens to try the editor, one folder per public DSL, each with its own config:

- `examples/cloudformation/yaml-dsl.yml` is the CloudFormation config;
- `examples/cloudformation/` holds templates from AWS's `aws-cloudformation-templates` repository, unchanged, with its Apache-2.0 license beside them.

A later public DSL joins as its own folder under `examples/`, with its own `yaml-dsl.yml`.

## Engine features it relies on

Each is designed in the editor's design doc:

- the config index, so `examples/cloudformation/yaml-dsl.yml` governs every YAML file in its folder;
- YAML tags, `tag_keys`;
- overlay includes, `layers.common_layer_discovery: overlay_includes`;
- a reference rule reading a scalar with its tag;
- the `['name']` path step;
- the branches the document selects, so a resource is documented and completed by its `Type`;
- calls through `marker_function` with `splat_operator: null`, the function table deciding a call's arguments.

## Open questions

- Counting a `${...}` as a placeholder only inside `Fn::Sub`.
- The variable map of `Fn::Sub`, whose names are declared and used within one `Fn::Sub`.
- Checking a `Fn::GetAtt` attribute against the attributes of the resource's `Type`.
- `Fn::ImportValue` reading an export another template in the repo declares under `Outputs`, a name visible across templates.
- A nested CloudFormation stack's `TemplateURL` opening the template in the repo it is packaged from.

Where one needs the editor to know more about a field than JSON Schema says, the generated schema carries it in one of the editor's own `x-yaml-dsl-` keywords, designed with the question.
