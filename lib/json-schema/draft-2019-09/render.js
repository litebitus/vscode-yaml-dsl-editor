const JSON_SCHEMA_DRAFT_2019_09_RENDERER = {
  tagRenderers: [
    { keyword: 'items', label: 'Items', render: (value, helpers) => helpers.itemsTextOf(value) },
    { keyword: 'additionalItems', label: 'Further items', render: (value, helpers) => helpers.itemsTextOf(value) },
    { keyword: 'dependentRequired', label: 'Dependencies', render: (value, helpers) => helpers.neededKeysTextOf(value) },
  ],
};

module.exports = { JSON_SCHEMA_DRAFT_2019_09_RENDERER };
