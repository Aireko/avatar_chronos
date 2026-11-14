import { describe, expect, it } from "vitest";
import { githubRepoFromRemote } from "./originRepo";

describe("githubRepoFromRemote", () => {
  it("reads https remotes, with or without .git and a trailing slash", () => {
    expect(githubRepoFromRemote("https://github.com/octo/hello-world.git")).toBe("octo/hello-world");
    expect(githubRepoFromRemote("https://github.com/octo/hello-world")).toBe("octo/hello-world");
    expect(githubRepoFromRemote("https://github.com/octo/hello-world/")).toBe("octo/hello-world");
    expect(githubRepoFromRemote("http://www.github.com/Octo/Repo.js.git")).toBe("Octo/Repo.js");
  });

  it("reads https remotes that carry a user or token", () => {
    expect(githubRepoFromRemote("https://someone@github.com/octo/app.git")).toBe("octo/app");
  });

  it("reads ssh remotes in both syntaxes", () => {
    expect(githubRepoFromRemote("git@github.com:octo/app.git")).toBe("octo/app");
    expect(githubRepoFromRemote("github.com:octo/app")).toBe("octo/app");
    expect(githubRepoFromRemote("ssh://git@github.com/octo/app.git")).toBe("octo/app");
    expect(githubRepoFromRemote("ssh://git@github.com:22/octo/app")).toBe("octo/app");
    expect(githubRepoFromRemote("git://github.com/octo/app.git")).toBe("octo/app");
  });

  it("ignores surrounding whitespace and anything after the first line", () => {
    expect(githubRepoFromRemote("  git@github.com:octo/app.git\r\n")).toBe("octo/app");
    expect(githubRepoFromRemote("https://github.com/octo/app\nsecond line")).toBe("octo/app");
  });

  it("rejects other hosts, look-alike hosts and odd paths", () => {
    expect(githubRepoFromRemote("https://gitlab.com/octo/app.git")).toBeUndefined();
    expect(githubRepoFromRemote("https://github.com.evil.example/octo/app")).toBeUndefined();
    expect(githubRepoFromRemote("https://notgithub.com/octo/app")).toBeUndefined();
    expect(githubRepoFromRemote("https://github.com/octo")).toBeUndefined();
    expect(githubRepoFromRemote("https://github.com/octo/app/tree/main")).toBeUndefined();
    expect(githubRepoFromRemote("https://github.com/octo/..")).toBeUndefined();
    expect(githubRepoFromRemote("https://github.com/-octo/app")).toBeUndefined();
    expect(githubRepoFromRemote("C:/code/app")).toBeUndefined();
    expect(githubRepoFromRemote("")).toBeUndefined();
  });
});
