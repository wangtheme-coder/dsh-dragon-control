# Third-party components

The plugin is self-contained: it launches the system browser and uses the installed .NET Framework/C# compiler build helpers. It does not embed an Electron runtime or copy another plugin's implementation.

| Component | Verified version | Source | Local package license |
| --- | --- | --- | --- |
| DSH tool runtime and Cordis distribution | DSH 0.2.0-rc.2 | https://github.com/deepseek-ai/deepseek-harness | Check the installed official packages and their notices |
| Microsoft Edge / Google Chrome (optional, launched from the system) | installed by the user | Microsoft / Google | Governed by the user's own installation; not redistributed |

`native/A11yProbe.cs`, `native/DragonNative.cs` and their executables are this project's UIA/desktop helpers. `test/fixtures/Fixture.cs` is this project's owned Windows integration fixture. Windows/.NET APIs are invoked from the locally installed system framework; Windows system DLLs and the compiler are not bundled here.

