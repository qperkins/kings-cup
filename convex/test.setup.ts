type ConvexModuleImport = () => Promise<unknown>;
export type ConvexModuleMap = Record<string, ConvexModuleImport>;

declare global {
  // Minimal typing needed for `import.meta.glob` without adding Vite to the project.
  interface ImportMeta {
    glob: (pattern: string) => ConvexModuleMap;
  }
}

export const modules: ConvexModuleMap = import.meta.glob("./**/!(*.*.*)*.*s");
