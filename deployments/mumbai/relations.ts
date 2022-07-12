import baseRelationConfig from '../relations';

export default {
  ...baseRelationConfig,
  'comet:implementation': {
    proxy: {
      field: (comet) => (comet.extensionDelegate ? comet.extensionDelegate() : null),
    },
    relations: {},
  },
};
