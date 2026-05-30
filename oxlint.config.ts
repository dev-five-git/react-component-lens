import devupConfig from 'eslint-plugin-devup/oxlint-config'
import { defineConfig } from 'oxlint'

export default defineConfig({
  extends: [devupConfig],
  ignorePatterns: ['conformance/fixtures/**', 'conformance/goldens/**'],
})
