# Contributing and validation

Keep two model-facing tools. Extend their action vocabulary and load detailed schemas through help. Preserve the existing top-level `{action, args, observation_id?}` API.

Run on Windows x64 with Node.js 24:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build:native
npm.cmd run smoke:cdp
```

Unit tests use Node built-ins. Native builds use Windows .NET Framework's C# compiler and UIAutomation assemblies; a missing compiler/assembly must fail clearly.

For integration, explicitly supply `DSH_RUNTIME_ROOT` containing a package.json and resolvable official DSH packages. Install the plugin itself into the target profile (no third-party backends are needed). Then run `npm.cmd run test:integration`. Do not bundle extracted application runtimes, account files or profiles into this repository. Integration fixtures and scripts live in this project; the script requires no source edits or hardcoded user path.

The test approval service approves only the controlled fixture test flow. It is not enabled in the production plugin. Report unit, native system integration, host approval UI, physical human input, and real-model validation separately. CI without a live desktop must not count simulated results as successful real desktop coverage.

Before a stable release: clean-profile tgz install/start/uninstall/rollback; human Escape and UI approval; a Notepad save workflow; mixed-DPI/multi-display and elevated-window matrices; native artifact hash; actual dependency versions/licenses; final staged-file/secret review. Preview reports must identify these outstanding checks. CI checks syntax, unit tests, a Windows native build and an isolated headless Chrome local fixture; it does not claim full DSH Desktop integration coverage.

Changes to permission behavior must include zero-side-effect denial tests and stale/changed-target tests. Do not allow tools to change their own grants, approve their own requests, or retry denied writes automatically. Do not record typed values, page scripts or credentials in action logs. Keep downloaded files, generated fixtures, installation metadata, test screenshots and local profiles out of version control.
