import { describe, expect, it } from "vitest";
import {
  RECENT_REPOS_KEY,
  addRecentRepo,
  cleanRepoPath,
  loadRecentRepos,
  nativeRepoPath,
  parseRecentRepos,
  removeRecentRepo,
  repoKey,
  repoName,
  saveRecentRepos,
  type RecentStorage,
} from "./recentRepos";

function fakeStorage(initial: Record<string, string> = {}): RecentStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

describe("cleanRepoPath / repoKey", () => {
  it("drops spaces and trailing slashes but keeps roots", () => {
    expect(cleanRepoPath("  C:\\code\\app\\\\ ")).toBe("C:\\code\\app");
    expect(cleanRepoPath("/home/me/app/")).toBe("/home/me/app");
    expect(cleanRepoPath("C:\\")).toBe("C:\\");
    expect(cleanRepoPath("/")).toBe("/");
  });

  it("ignores case and the slash direction", () => {
    expect(repoKey("C:\\Code\\App\\")).toBe(repoKey("c:/code/app"));
  });
});

describe("addRecentRepo", () => {
  it("puts the newest first and removes other spellings of it", () => {
    const list = ["C:/code/one", "C:\\Code\\Two"];
    expect(addRecentRepo(list, "c:\\code\\two\\")).toEqual(["c:\\code\\two", "C:/code/one"]);
  });

  it("keeps at most eight", () => {
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = addRecentRepo(list, `/r/${i}`);
    expect(list).toHaveLength(8);
    expect(list[0]).toBe("/r/11");
    expect(list[7]).toBe("/r/4");
  });

  it("ignores an empty path", () => {
    expect(addRecentRepo(["/a"], "   ")).toEqual(["/a"]);
  });
});

describe("removeRecentRepo", () => {
  it("removes every spelling of the path", () => {
    expect(removeRecentRepo(["C:/a", "C:/b"], "c:\\A\\")).toEqual(["C:/b"]);
  });
});

describe("parseRecentRepos", () => {
  it("tolerates junk", () => {
    expect(parseRecentRepos(null)).toEqual([]);
    expect(parseRecentRepos("not json")).toEqual([]);
    expect(parseRecentRepos('{"a":1}')).toEqual([]);
    expect(parseRecentRepos('[1, null, "", "  ", {"x":1}, "/ok/", "/OK", "/two"]')).toEqual(["/ok", "/two"]);
  });

  it("caps a long stored list", () => {
    const raw = JSON.stringify(Array.from({ length: 20 }, (_, i) => `/r/${i}`));
    expect(parseRecentRepos(raw)).toHaveLength(8);
  });
});

describe("load / save", () => {
  it("round-trips through storage", () => {
    const store = fakeStorage();
    saveRecentRepos(() => store, ["/a", "/b"]);
    expect(store.data.get(RECENT_REPOS_KEY)).toBe('["/a","/b"]');
    expect(loadRecentRepos(() => store)).toEqual(["/a", "/b"]);
  });

  it("never throws when storage is blocked or missing", () => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    expect(loadRecentRepos(blocked)).toEqual([]);
    expect(() => saveRecentRepos(blocked, ["/a"])).not.toThrow();
    const full: RecentStorage = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadRecentRepos(() => full)).toEqual([]);
    expect(() => saveRecentRepos(() => full, ["/a"])).not.toThrow();
    expect(loadRecentRepos(() => null)).toEqual([]);
  });
});

describe("repoName", () => {
  it("is the last folder", () => {
    expect(repoName("C:\\code\\chronos\\")).toBe("chronos");
    expect(repoName("/home/me/app")).toBe("app");
  });
});

describe("nativeRepoPath", () => {
  it("gives Windows drive paths backslashes, as git reports them with slashes", () => {
    expect(nativeRepoPath("C:/code/proj")).toBe("C:\\code\\proj");
    expect(nativeRepoPath("C:\\code/proj")).toBe("C:\\code\\proj");
    expect(nativeRepoPath("C:\\code\\proj")).toBe("C:\\code\\proj");
  });

  it("keeps other paths as they are", () => {
    expect(nativeRepoPath("/home/me/app")).toBe("/home/me/app");
  });
});
