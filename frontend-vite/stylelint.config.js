export default {
  extends: ['stylelint-config-standard'],
  ignoreFiles: ['node_modules/**', '../frontend-dist/**', 'build/**', 'vendor/**'],
  rules: {
    'alpha-value-notation': null,
    'color-function-notation': null,
    'custom-property-empty-line-before': null,
    'value-keyword-case': null,
  },
};
