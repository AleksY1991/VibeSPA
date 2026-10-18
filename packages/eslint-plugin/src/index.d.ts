import type { ESLint, Linter } from 'eslint';

export interface ArchitectureOptions {
  files?: string[];
  rootDir?: string;
  /** Prefix-to-directory mappings, relative to rootDir. Longest prefix wins. */
  aliases?: Record<string, string>;
  /** Directories containing named micro-modules. Supports * and **. */
  moduleRoots?: string[];
  packageRoots?: string[];
  domainRoots?: string[];
  uiRoots?: string[];
  contractRoots?: string[];
  /** Exact files or patterns that may bind a module to UI rendering. */
  uiAdapters?: string[];
  allowedUiImports?: string[];
  forbiddenUiImports?: string[];
  declarationFactories?: string[];
  /** Additional inert metadata imports allowed in definition.ts. */
  definitionImports?: string[];
}

export function createArchitectureConfig(options?: ArchitectureOptions): Linter.Config[];
declare const plugin: ESLint.Plugin;
export default plugin;
