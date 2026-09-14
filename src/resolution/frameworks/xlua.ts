/**
 * xLua ↔ C# bridge resolver.
 *
 * Closes the cross-language flow gap in Unity projects that use
 * tencent/xLua — C# game code with `.cs`, Lua logic with `.lua`
 * (or `.lua.txt` Resources payloads, both indexed as `lua`). The
 * existing name-matcher resolves within each language fine; the
 * boundary between them has NO static edges, so `codegraph_explore`
 * stops at `CS.` and `LuaEnv` proxies. This resolver bridges both
 * directions:
 *
 * **1. Lua call → C# (LuaCallCSharp).** xLua exposes every C#
 * assembly type under the global `CS` table:
 *
 *   - `CS.UnityEngine.Debug.Log(v)` — extraction emits the callee
 *     as the FULL dotted chain (`CS.UnityEngine.Debug.Log`), so we
 *     strip the `CS.` prefix, find the C# type named by the chain,
 *     then the method on it (validated by qualifiedName, never by
 *     bare-name guessing — a Lua `Foo.Bar()` may not name a C# `Foo`).
 *   - `CS.Player.Inst:Move()` — chain + colon: receiver is
 *     `Player.Inst` (an instance property), the method is `Move`;
 *     we shorten the receiver from the most specific segment until a
 *     C# type matches, then resolve `Move` on it.
 *   - A bare `CS.MyGame.Player` (constructor / static access) becomes
 *     a `references` edge to the C# type node.
 *   - **Project dialect — the GetCSharp alias table.** The repo
 *     generates a file that maps short names onto full C# namespace
 *     paths without the `CS.` prefix dance:
 *
 *         local types = {}
 *         function GetCSharp(typeName) return types[typeName] or nil end
 *         types['SceneManagement'] = function() return CS.UnityEngine.SceneManagement end
 *         types['Cinemachine']     = function() return CS.Cinemachine end
 *
 *     `GetCSharp('SceneManagement')` (and `types['SceneManagement']`
 *     used as a value) therefore refers to the C# namespace
 *     `UnityEngine.SceneManagement`; we mint `xlua.alias.<name>` refs
 *     where they appear and resolve them through the alias table
 *     (parsed from the generated file, cached per context).
 *
 * **2. C# → Lua (CSharpCallLua).** C# binds a Lua global function by
 *     name through the LuaTable API — `env.Global.Get<Func<int,int>
 *     >("Fight.Add")` (also `Get<Action>` / `LuaTable.Get<T>` /
 *     `GetFunction`). The string argument is a Lua global path that
 *     tree-sitter never sees, so `extract()` mints a `calls` ref for
 *     it and `resolve()` links it to the Lua function / table-method
 *     node whose qualifiedName matches (`Fight::Add`). The bridge is
 *     conservative: an external/unknown path simply stays unresolved,
 *     and C# internal calls that happen to be dotted are never
 *     redirected unless they actually match a Lua symbol.
 *
 * **Provenance:** edges are `resolvedBy: 'framework'` with
 * `confidence: 0.8` (method/call bridges) / 0.7 (type references) —
 * below the ≥0.9 early-return bar, so a same-language name-match at
 * the call site can still win where both exist. Mirrors the
 * swift-objc precedent (`resolvedBy: 'framework'`, deterministic from
 * the bridging rule, not the agent's imagination).
 */
import { FrameworkResolver, ResolvedRef, ResolutionContext, UnresolvedRef } from '../types';
import type { Node } from '../../types';

/**
 * C# node kinds that can name a target on the right of `CS.` — types
 * first, plus `namespace` so a bare `CS.MyGame` / `GetCSharp('Game')`
 * resolves to the namespace node when no class of that name exists
 * (the alias dialect's whole point). Type lookups try the longest path
 * first, so `MyGame.Player` still prefers the class over the namespace.
 */
const CSHARP_TYPE_KINDS = new Set<Node['kind']>(['class', 'struct', 'interface', 'enum', 'union', 'type_alias', 'namespace']);

/** Files that look like Lua, including xLua's `.lua.txt` Resources convention. */
function isLuaFilePath(filePath: string): boolean {
  return filePath.endsWith('.lua') || filePath.endsWith('.luau') || filePath.endsWith('.lua.txt');
}

/**
 * Alias-table cache, keyed by ResolutionContext identity (rebuilt when
 * the graph is rebuilt/opened; shared processes must not bleed maps).
 * Maps short name → C# dotted path after `CS.` (e.g. `Cinemachine` →
 * `Cinemachine`, `SceneManagement` → `UnityEngine.SceneManagement`).
 */
const dialectAliases = new WeakMap<ResolutionContext, Map<string, string>>();

/** Parse the generated `types['X'] = function() return CS.Y end` table. */
function buildDialectAliases(context: ResolutionContext): Map<string, string> {
  const cached = dialectAliases.get(context);
  if (cached) return cached;

  const map = new Map<string, string>();
  const re = /types\s*\[\s*['"]([^'"]+)['"]\s*\]\s*=\s*function\s*\(\s*\)\s*return\s+(CS\.[A-Za-z_][\w.]*)\s+end/g;
  for (const file of context.getAllFiles()) {
    if (!isLuaFilePath(file)) continue;
    const content = context.readFile(file);
    if (!content) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const alias = m[1]!;
      const csPath = m[2]!.slice('CS.'.length); // `CS.UnityEngine.SceneManagement` → `UnityEngine.SceneManagement`
      if (alias && csPath) map.set(alias, csPath);
    }
  }
  dialectAliases.set(context, map);
  return map;
}

/** C# namespace/type text match: accept both the `A.B` and `A::B` spellings. */
function qualifiedNameMatchesPath(qualifiedName: string, dottedPath: string): boolean {
  if (qualifiedName === dottedPath || qualifiedName.endsWith('::' + dottedPath)) return true;
  const scoped = dottedPath.replace(/\./g, '::');
  return qualifiedName === scoped || qualifiedName.endsWith('::' + scoped);
}

/**
 * Find the most specific C# type node for a dotted path (`MyGame.Player`
 * → the class whose qualifiedName is `MyGame::Player`). Tries the longest
 * candidate first so `A.B.C` prefers class `A.B::C` over namespace `A::B`.
 */
function csharpTypeForPathCs(path: string, context: ResolutionContext): Node | null {
  const segments = path.split('.');
  for (let len = segments.length; len >= 1; len--) {
    const sub = segments.slice(0, len).join('.');
    const hits = context
      .getNodesByName(segments[len - 1]!)
      .filter(
        (n) =>
          n.language === 'csharp' &&
          CSHARP_TYPE_KINDS.has(n.kind) &&
          qualifiedNameMatchesPath(n.qualifiedName, sub)
      );
    if (hits.length > 0) return hits[0]!;
  }
  return null;
}

/** A C# method/function declared on `typeNode` (qualifiedName-validated). */
function csharpMethodOnType(typeNode: Node, methodName: string, context: ResolutionContext): Node | null {
  const hits = context
    .getNodesByName(methodName)
    .filter(
      (n) =>
        n.language === 'csharp' &&
        (n.kind === 'method' || n.kind === 'function') &&
        n.qualifiedName !== typeNode.qualifiedName && // no self-reference
        (n.qualifiedName === `${typeNode.qualifiedName}::${methodName}` ||
          n.qualifiedName.startsWith(`${typeNode.qualifiedName}::`))
    );
  return hits[0] ?? null;
}

/**
 * Lua internal `self` receiver resolution (metatable class idiom).
 *
 * `self:Method()` inside `function LevelLoaderManager:OnStart()` is the
 * canonical Lua class call — but `self` is a keyword, so static analysis
 * cannot name the table it refers to, and the upstream name-matcher has
 * no Lua `self` handling (its `this.` equivalent exists for TS only).
 * Every class-internal call therefore dies: `callers LevelLoaderManager.Init`
 * is empty despite three `self:Init()` call sites.
 *
 * `self` is NOT dynamic though: inside method M of table T, `self:Method()`
 * ALWAYS means T.Method — the receiver is the current method's own table.
 * So we read the calling method off `ref.fromNodeId`, take its qualifiedName
 * receiver (`LevelLoaderManager::OnStart` → `LevelLoaderManager`), and look
 * for `LevelLoaderManager::Method` in the SAME file. Same-file + same-table
 * double constraint — a wrong edge is near-impossible.
 */
function resolveLuaSelfCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = ref.referenceName.match(/^self[:.]([A-Za-z_]\w*)$/);
  if (!m) return null;
  const methodName = m[1]!;
  if (!context.getNodeById) return null;
  const fromNode = context.getNodeById(ref.fromNodeId);
  if (!fromNode || fromNode.kind !== 'method') return null;
  const sep = fromNode.qualifiedName.lastIndexOf('::');
  if (sep <= 0) return null; // no table receiver (a top-level function)
  const receiver = fromNode.qualifiedName.slice(0, sep);
  const hits = context
    .getNodesByName(methodName)
    .filter(
      (n) =>
        n.language === 'lua' &&
        n.kind === 'method' &&
        n.filePath === fromNode.filePath &&
        n.qualifiedName.startsWith(receiver + '::') &&
        n.id !== fromNode.id
    );
  if (hits.length === 0) return null;
  return {
    original: ref,
    targetNodeId: hits[0]!.id,
    confidence: 0.7,
    resolvedBy: 'framework',
  };
}

/**
 * Lua → C# via an instance field: `self.levelJobManager:Init(...)`.
 *
 * The field holds a C# object (xLua wraps Unity `AddComponent<T>()` results
 * and `CS.X.Instance` singletons), so the chain is
 * Lua method → XLua proxy → C# method. The upstream matcher cannot infer the
 * field's type (no declaration type in Lua), so we recover it from the
 * file's own assignment: `self.<field> = AddComponent<Type>()` /
 * `AddComponent(typeof(Type))` / `CS.Full.Path.Class(.Instance)`. Any of
 * those yields a dotted C# path, resolved with the same qualifiedName-
 * validated machinery as `CS.` chains. No assignment → stay unresolved.
 *
 * Field→type map is memoized per (context, file), since resolution hits the
 * same field from many call sites.
 */
const luaFieldTypes = new WeakMap<ResolutionContext, Map<string, Map<string, string>>>();

/** Extract `self.<field> = <kind of C# value>` assignments → C# dotted path. */
function luaFieldCsharpPaths(context: ResolutionContext, filePath: string): Map<string, string> {
  let byFile = luaFieldTypes.get(context);
  if (!byFile) {
    byFile = new Map();
    luaFieldTypes.set(context, byFile);
  }
  const cached = byFile.get(filePath);
  if (cached) return cached;

  const result = new Map<string, string>();
  const content = context.readFile(filePath);
  if (content) {
    // Whole-file scan: keep the LAST meaningful `self.<field> = …` per field
    // (memoized, so this runs once per file per resolver lifetime). A
    // cleanup `self.x = nil` must NOT overwrite the earlier typed assignment
    // (`self.x = self.root:AddComponent(T)`) it nulls out — skip nils.
    const assignRe = /self\.([A-Za-z_]\w*)\s*=\s*([^\r\n]+)/g;
    let am: RegExpExecArray | null;
    const lastRhs = new Map<string, string>();
    while ((am = assignRe.exec(content)) !== null) {
      const rhs = am[2]!.trim();
      if (!rhs || rhs === 'nil') continue;
      lastRhs.set(am[1]!, rhs);
    }
    // Accepts AddComponent<T>(), AddComponent(typeof(T)) and the xLua
    // shorthand that passes the C# type table directly: AddComponent(T).
    const typeRe = /AddComponent\s*(?:<([A-Za-z0-9_.]+)>|\(\s*typeof\s*\(\s*([A-Za-z0-9_.]+)\s*\)\s*\)|\(\s*([A-Za-z0-9_.]+)\s*\))|CS\.([A-Za-z0-9_.]+)/g;
    for (const [field, rhs] of lastRhs) {
      let tm: RegExpExecArray | null;
      typeRe.lastIndex = 0;
      while ((tm = typeRe.exec(rhs)) !== null) {
        const found: string | undefined = tm[1] ?? tm[2] ?? tm[3] ?? tm[4];
        if (found && !/[<"(]/.test(found)) {
          result.set(field, found);
        }
      }
    }
  }
  byFile.set(filePath, result);
  return result;
}

/** `self.<field>:Method()` / `self.<field>.Method()` → C# method on the field's type. */
function resolveLuaFieldCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const m = ref.referenceName.match(/^self\.([A-Za-z_]\w*)[:.]([A-Za-z_]\w*)$/);
  if (!m) return null;
  const [, field, methodName] = m;
  const csPath = luaFieldCsharpPaths(context, ref.filePath).get(field!);
  if (process.env.CODEGRAPH_XLUA_DEBUG) {
    console.error(`[xlua-field] ${ref.filePath}:${ref.line} field=${field} method=${methodName} csPath=${csPath ?? 'NONE'}`);
  }
  if (!csPath) return null;
  const typeNode = csharpTypeForPathCs(csPath, context);
  if (process.env.CODEGRAPH_XLUA_DEBUG) {
    console.error(`[xlua-field]   typeNode=${typeNode?.qualifiedName ?? 'NULL'} (lookup "${csPath}")`);
  }
  if (!typeNode) return null;
  const target = csharpMethodOnType(typeNode, methodName!, context);
  if (process.env.CODEGRAPH_XLUA_DEBUG) {
    console.error(`[xlua-field]   target=${target?.qualifiedName ?? 'NULL'}`);
  }
  if (!target) return null;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.7,
    resolvedBy: 'framework',
  };
}

/**
 * Lua → C#. Accepts `CS.A.B`, `CS.A.B:Method`, `CS.A.B.Method` (the
 * extraction shape), the dialect `xlua.alias.<name>` refs, and — first —
 * the Lua self/field forms (`self:Method()`, `self.mgr:Go()`).
 */
function resolveLuaToCsharp(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== 'lua' && ref.language !== 'luau') return null;
  if (ref.referenceName.startsWith('self.') || ref.referenceName.startsWith('self:')) {
    // self.… is either the class-internal call (`self:Init`) or an instance
    // field call (`self.mgr:Go()`); try the internal one first — it is the
    // same-file same-table match and wins when both could apply.
    return resolveLuaSelfCall(ref, context) ?? resolveLuaFieldCall(ref, context);
  }
  const chain = ref.referenceName;

  // Dialect alias: GetCSharp('SceneManagement') / types['Cinemachine'] as value.
  if (chain.startsWith('xlua.alias.')) {
    const alias = chain.slice('xlua.alias.'.length);
    if (!/^[A-Za-z_]\w*$/.test(alias)) return null;
    const csPath = buildDialectAliases(context).get(alias);
    if (!csPath) return null;
    const target = csharpTypeForPathCs(csPath, context);
    if (!target) return null; // external (UnityEngine…) — stays unresolved, correct
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.7,
      resolvedBy: 'framework',
    };
  }

  if (!chain.includes('CS.')) return null;

  let rest = chain.slice(chain.indexOf('CS.') + 'CS.'.length);
  if (!rest) return null;

  // `CS.A.B:Method` — colon form (`:` is Lua method-call syntax).
  const colonIdx = rest.indexOf(':');
  let methodName: string | null = null;
  if (colonIdx >= 0) {
    const recv = rest.slice(0, colonIdx);
    methodName = rest.slice(colonIdx + 1);
    rest = recv;
  } else {
    // `CS.A.B.Method` — split the last segment as the method candidate.
    const lastDot = rest.lastIndexOf('.');
    if (lastDot > 0) {
      methodName = rest.slice(lastDot + 1);
      rest = rest.slice(0, lastDot);
    }
  }

  // Shorten the receiver until a C# type matches (instance-property hops
  // like `Player.Inst` fall away); only then look up the method.
  const typeNode = csharpTypeForPathCs(rest, context);
  if (!typeNode) return null;
  if (!methodName) {
    return {
      original: ref,
      targetNodeId: typeNode.id,
      confidence: 0.7,
      resolvedBy: 'framework',
    };
  }
  const target = csharpMethodOnType(typeNode, methodName, context);
  if (!target) return null;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.8,
    resolvedBy: 'framework',
  };
}

/**
 * C# → Lua. Resolves a dotted Lua global path (`Fight.Add`,
 * `UI.HUD.HpBar.Show`) to the Lua function/table-method node whose
 * qualifiedName matches. Tries the LONGEST receiver first so
 * `UI.HUD.HpBar.Show` prefers the method on `UI.HUD::HpBar`.
 */
function resolveCsharpToLua(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== 'csharp') return null;
  const path = ref.referenceName;
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,3}$/.test(path)) return null;
  const segments = path.split('.');
  for (let i = segments.length - 1; i >= 1; i--) {
    const receiver = segments.slice(0, i).join('.');
    const method = segments[i]!;
    const want = `${receiver}::${method}`;
    const hits = context
      .getNodesByName(method)
      .filter(
        (n) =>
          n.language === 'lua' &&
          (n.kind === 'method' || n.kind === 'function') &&
          (n.qualifiedName === want || n.qualifiedName.endsWith('::' + want))
      );
    if (hits.length > 0) {
      return {
        original: ref,
        targetNodeId: hits[0]!.id,
        confidence: 0.8,
        resolvedBy: 'framework',
      };
    }
  }
  return null;
}

/** C# LuaTable binding calls whose string first argument names a Lua path.
 *  `<…>` is nested-generic tolerant — `Get<Func<int, int>>("Fight.Add")`
 *  has TWO closing `>` (`Func<int, int>` plus the wrapping one). */
const LUA_BIND_RE = /\.(?:Get|GetFunction|GetTable|GetInPath)\s*(?:<(?:[^<>]|<[^>]*>)*>)?\s*\(\s*["']([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)["']/g;

/**
 * Mint refs tree-sitter can't see:
 *  - `.cs`: `env.Global.Get<Action>("Fight.Add")` → the Lua path string
 *    becomes a `calls` ref (only in files that actually talk to xLua).
 *  - `.lua`: `GetCSharp('X')` / `types['X']` value uses → `xlua.alias.X`
 *    refs that the alias table then routes at C# types.
 */
function extract(filePath: string, content: string) {
  const refs: UnresolvedRef[] = [];
  if (filePath.endsWith('.cs')) {
    if (!/(?:LuaEnv|CSharpCallLua|LuaTable|LuaFunction|\.Global\b)/.test(content)) return { nodes: [], references: refs };
    let m: RegExpExecArray | null;
    LUA_BIND_RE.lastIndex = 0;
    while ((m = LUA_BIND_RE.exec(content)) !== null) {
      const luaPath = m[1]!;
      if (!luaPath) continue;
      const line = content.slice(0, m.index).split('\n').length;
      refs.push({
        fromNodeId: `file:${filePath}`,
        referenceName: luaPath,
        referenceKind: 'calls',
        line,
        column: m.index - content.lastIndexOf('\n', m.index) - 1,
        filePath,
        language: 'csharp',
      });
    }
  } else if (isLuaFilePath(filePath)) {
    // Dialect: `GetCSharp('SceneManagement')` — a call into the alias table.
    let m: RegExpExecArray | null;
    const callRe = /GetCSharp\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = callRe.exec(content)) !== null) {
      const alias = m[1]!;
      if (!/^[A-Za-z_]\w*$/.test(alias)) continue;
      const line = content.slice(0, m.index).split('\n').length;
      refs.push({
        fromNodeId: `file:${filePath}`,
        referenceName: `xlua.alias.${alias}`,
        referenceKind: 'references',
        line,
        column: m.index - content.lastIndexOf('\n', m.index) - 1,
        filePath,
        language: 'lua',
      });
    }
    // Dialect: `types['X']` used as a VALUE (not the `= function() return` definition).
    const idxRe = /types\s*\[\s*['"]([^'"]+)['"]\s*]\s*(?!=\s*function)/g;
    while ((m = idxRe.exec(content)) !== null) {
      const alias = m[1]!;
      if (!/^[A-Za-z_]\w*$/.test(alias)) continue;
      const line = content.slice(0, m.index).split('\n').length;
      refs.push({
        fromNodeId: `file:${filePath}`,
        referenceName: `xlua.alias.${alias}`,
        referenceKind: 'references',
        line,
        column: m.index - content.lastIndexOf('\n', m.index) - 1,
        filePath,
        language: 'lua',
      });
    }
  }
  return { nodes: [], references: refs };
}

export const xluaBridgeResolver: FrameworkResolver = {
  name: 'xlua-bridge',
  /** Bridging crosses the boundary — both sides opt in. */
  languages: ['lua', 'luau', 'csharp'],

  /**
   * Detect xLua: a Unity project whose Lua side calls `CS.` types or
   * whose C# side drives a LuaEnv. `CS.` alone is a strong xLua signal
   * (no other Lua dialect exposes C# assemblies under that name), and
   * `LuaEnv`/`[CSharpCallLua]`/`LuaTable` pins the C# side. Scans are
   * bounded so a huge repo's discover pass stays cheap.
   */
  detect(context) {
    const files = context.getAllFiles();
    let scanned = 0;
    for (const f of files) {
      if (++scanned > 4000) break;
      if (isLuaFilePath(f)) {
        const c = context.readFile(f);
        if (c && (c.includes('CS.') || c.includes('GetCSharp(') || c.includes('require("xlua")') || c.includes("require('xlua')"))) {
          return true;
        }
      } else if (f.endsWith('.cs')) {
        const c = context.readFile(f);
        if (c && (c.includes('LuaEnv') || c.includes('CSharpCallLua') || c.includes('LuaCallCSharp') || c.includes('xlua'))) {
          return true;
        }
      }
    }
    return false;
  },

  /**
   * Opt names through the name-exists pre-filter when no node carries
   * them verbatim: Lua `CS.A.B.Method()` chains, our `xlua.alias.*`
   * dialect refs, and C# dotted Lua paths (`Fight.Add`) extracted from
   * LuaTable binding calls. C# internal dotted calls arrive too — the
   * resolve side rejects anything that doesn't actually match a Lua
   * symbol, so this is a cheap prompt, not a commitment.
   */
  claimsReference(name) {
    if (name.startsWith('xlua.')) return true;
    // Lua `self:Method()` / `self.field:Method()` — no node is ever NAMED
    // `self:…`, so the name-exists pre-filter would drop the ref before the
    // self/field resolvers above can see it.
    if (name.startsWith('self.') || name.startsWith('self:')) return true;
    if (name.includes('CS.')) return true;
    return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){1,3}$/.test(name);
  },

  extract,

  /**
   * Route by caller language, exactly like the swift-objc bridge: the
   * two directions share no implementation.
   */
  resolve(ref, context) {
    if (ref.language === 'lua' || ref.language === 'luau') {
      return resolveLuaToCsharp(ref, context);
    }
    if (ref.language === 'csharp') {
      return resolveCsharpToLua(ref, context);
    }
    return null;
  },
};