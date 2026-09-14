import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// Mini xLua-style Unity project: C# game code, Lua logic, and the
// generated GetCSharp/types[] namespace-alias dialect file.
const CS_PLAYER = `namespace MyGame {
    public class Player {
        public static void Go() { }
        public void Dash() { }
    }
}
`;

const CS_MAIN = `using XLua;
public class Main {
    void Start() {
        LuaEnv env = new LuaEnv();
        env.Global.Get<System.Action>("Fight.DoThing");
        env.Global.Get<System.Func<int, int>>("Fight.Add");
    }
}
`;

const LUA_FIGHT = `Fight = Fight or {}
function Fight.DoThing() end
function Fight.Add(v) return v + 1 end
`;

const LUA_HERO = `-- Lua calls into C# via the CS table
CS.MyGame.Player.Go()
CS.MyGame.Player:Dash()
local g = GetCSharp('Game')
local t = types['Game']
-- external / unknown: must stay unresolved
CS.UnityEngine.Debug.Log("x")
CS.MyGame.NoSuchThing()
`;

const LUA_TYPES = `--------Auto Export, Don't modify it manually---------
local types = {}
function GetCSharp(typeName)
    return types[typeName] or nil
end
types['Game'] = function() return CS.MyGame end
`;

describe('xlua bridge (C# ↔ Lua)', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  function fileNode(rel: string): Node | undefined {
    return cg.getNodesInFile(rel).find((n) => n.kind === 'file');
  }

  function findNode(name: string, kind: Node['kind'], language?: string): Node | undefined {
    return cg
      .getNodesByName(name)
      .find((n) => n.kind === kind && (!language || n.language === language));
  }

  function edgesFrom(rel: string): ReturnType<CodeGraph['getOutgoingEdges']> {
    const node = fileNode(rel);
    expect(node).toBeDefined();
    return cg.getOutgoingEdges(node!.id);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-xlua-'));
    fs.mkdirSync(path.join(tmpDir, 'Game'));
    fs.writeFileSync(path.join(tmpDir, 'Game/Player.cs'), CS_PLAYER);
    fs.writeFileSync(path.join(tmpDir, 'Main.cs'), CS_MAIN);
    fs.writeFileSync(path.join(tmpDir, 'Fight.lua'), LUA_FIGHT);
    fs.writeFileSync(path.join(tmpDir, 'Hero.lua'), LUA_HERO);
    fs.writeFileSync(path.join(tmpDir, 'ApiTypes.lua'), LUA_TYPES);
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('links Lua CS.MyGame.Player.Go() to the C# static method', () => {
    const target = findNode('Go', 'method', 'csharp');
    expect(target).toBeDefined();
    expect(target!.qualifiedName).toBe('MyGame::Player::Go');
    const edges = edgesFrom('Hero.lua');
    const toTarget = edges.find((e) => e.target === target!.id);
    expect(toTarget).toBeDefined();
    expect(toTarget!.kind).toBe('calls');
  });

  it('links Lua CS.MyGame.Player:Dash() (colon form) to the C# method', () => {
    const target = findNode('Dash', 'method', 'csharp');
    expect(target).toBeDefined();
    const edges = edgesFrom('Hero.lua');
    expect(edges.some((e) => e.target === target!.id && e.kind === 'calls')).toBe(true);
  });

  it('does not link external or unknown CS. chains', () => {
    const edges = edgesFrom('Hero.lua');
    // UnityEngine is not in the index — the ref stays unresolved.
    const external = edges.find((e) => e.target === findNode('Log', 'method')?.id);
    expect(external).toBeUndefined();
    // A bare unknown chain produces no edge to any node.
    const noSuch = cg.getNodesByName('NoSuchThing');
    expect(noSuch).toHaveLength(0);
  });

  it('resolves GetCSharp and types[] dialect uses to the C# namespace', () => {
    const ns = findNode('MyGame', 'namespace', 'csharp');
    expect(ns).toBeDefined();
    const edges = edgesFrom('Hero.lua');
    const toNs = edges.filter((e) => e.target === ns!.id);
    // Both the GetCSharp('Game') call and the types['Game'] value use.
    expect(toNs.length).toBeGreaterThanOrEqual(2);
    expect(toNs.every((e) => e.kind === 'references')).toBe(true);
  });

  it('links C# LuaTable.Get<Action>("Fight.DoThing") to the Lua function', () => {
    const target = findNode('DoThing', 'method', 'lua');
    expect(target).toBeDefined();
    expect(target!.qualifiedName).toBe('Fight::DoThing');
    const edges = edgesFrom('Main.cs');
    const toTarget = edges.find((e) => e.target === target!.id);
    expect(toTarget).toBeDefined();
    expect(toTarget!.kind).toBe('calls');
  });

  it('links both LuaTable bindings from the same file', () => {
    const doThing = findNode('DoThing', 'method', 'lua');
    const add = findNode('Add', 'method', 'lua');
    expect(doThing).toBeDefined();
    expect(add).toBeDefined();
    const edges = edgesFrom('Main.cs');
    expect(edges.some((e) => e.target === doThing!.id)).toBe(true);
    expect(edges.some((e) => e.target === add!.id)).toBe(true);
  });

  it('does not fabricate C#->Lua links for ordinary dotted C# calls', () => {
    // env.Global.Get is a normal C# chain: no Lua symbol named Global::Get
    // exists, so no edge to a Lua node is produced for it.
    const luaNodes = cg
      .getNodesByName('Get')
      .filter((n) => n.language === 'lua');
    const edges = edgesFrom('Main.cs');
    for (const ln of luaNodes) {
      expect(edges.some((e) => e.target === ln.id)).toBe(false);
    }
  });
});