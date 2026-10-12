import type { IntrospectionQuery } from "graphql";

/** Schemas fetched by introspection, kept per endpoint for the session. */
const cache = new Map<string, IntrospectionQuery>();
export const cachedSchema = (key: string) => cache.get(key);
export const storeSchema = (key: string, s: IntrospectionQuery) => cache.set(key, s);
export const dropSchema = (key: string) => cache.delete(key);

/** graphql-js is loaded on demand: most sessions never touch GraphQL. */
export const loadGraphQL = () => import("graphql");
export const loadCm6 = () => import("cm6-graphql");

export type DocType = {
  name: string;
  kind: string;
  description?: string | null;
  fields: { name: string; type: string; args: string; description?: string | null; deprecated?: boolean }[];
  enumValues: string[];
};

const typeStr = (t: any): string => (t.kind === "NON_NULL" ? `${typeStr(t.ofType)}!` : t.kind === "LIST" ? `[${typeStr(t.ofType)}]` : t.name);

/** Flatten an introspection result into something a docs browser can render without graphql-js. */
export function docsFrom(intro: IntrospectionQuery): { roots: { query?: string; mutation?: string; subscription?: string }; types: DocType[] } {
  const s: any = intro.__schema;
  const types: DocType[] = (s.types as any[])
    .filter((t) => !t.name.startsWith("__"))
    .map((t) => ({
      name: t.name,
      kind: t.kind,
      description: t.description,
      fields: (t.fields ?? t.inputFields ?? []).map((f: any) => ({
        name: f.name,
        type: typeStr(f.type),
        args: (f.args ?? []).map((a: any) => `${a.name}: ${typeStr(a.type)}`).join(", "),
        description: f.description,
        deprecated: f.isDeprecated,
      })),
      enumValues: (t.enumValues ?? []).map((e: any) => e.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { roots: { query: s.queryType?.name, mutation: s.mutationType?.name, subscription: s.subscriptionType?.name }, types };
}
