using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

class A11yProbe {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, int length, out int needed);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint rights, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exit, out long kernel, out long user);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int length, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    static string Limit(string value, int max) { return value == null ? "" : value.Substring(0, Math.Min(max, value.Length)); }
    static object Get(Dictionary<string,object> value, string key) { object result; return value.TryGetValue(key, out result) ? result : null; }
    static string Str(Dictionary<string,object> value, string key) { return Convert.ToString(Get(value, key)); }
    static Dictionary<string,object> Obj(Dictionary<string,object> value, string key) { return Get(value, key) as Dictionary<string,object>; }
    static void Fail(string code) { throw new InvalidOperationException(code); }
    static string InputDesktop() {
        IntPtr desktop = OpenInputDesktop(0, false, 1); if (desktop == IntPtr.Zero) return "unavailable";
        try { var name = new StringBuilder(256); int needed; return GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) ? name.ToString() : "unavailable"; }
        finally { CloseDesktop(desktop); }
    }
    static int Integrity(IntPtr process) {
        IntPtr token; if (!OpenProcessToken(process, 8, out token)) return -1;
        try {
            int size; GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
            if (size <= 0 || size > 65536) return -1;
            IntPtr memory = Marshal.AllocHGlobal(size);
            try {
                if (!GetTokenInformation(token, 25, memory, size, out size)) return -1;
                IntPtr sid = Marshal.ReadIntPtr(memory);
                byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                return count == 0 ? -1 : Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            } finally { Marshal.FreeHGlobal(memory); }
        } finally { CloseHandle(token); }
    }
    static Dictionary<string,object> Inspect(long id) {
        IntPtr hwnd = new IntPtr(id); if (!IsWindow(hwnd)) Fail("DRAGON_WINDOW_GONE");
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        IntPtr process = OpenProcess(0x1000, false, pid);
        string path = "", created = ""; int integrity = -1;
        if (process != IntPtr.Zero) {
            try {
                var buffer = new StringBuilder(32768); int size = buffer.Capacity;
                if (QueryFullProcessImageName(process, 0, buffer, ref size)) path = buffer.ToString();
                long a, b, c, d; if (GetProcessTimes(process, out a, out b, out c, out d)) created = a.ToString();
                integrity = Integrity(process);
            } finally { CloseHandle(process); }
        }
        int ownIntegrity = Integrity(Process.GetCurrentProcess().Handle);
        var cls = new StringBuilder(512); GetClassName(hwnd, cls, cls.Capacity);
        uint dpi = 96; try { uint actual = GetDpiForWindow(hwnd); if (actual > 0) dpi = actual; } catch (EntryPointNotFoundException) { }
        string desktop = InputDesktop();
        return new Dictionary<string,object> {
            {"windowId", id}, {"pid", pid}, {"path", path}, {"created", created}, {"className", cls.ToString()},
            {"integrity", integrity}, {"ownIntegrity", ownIntegrity}, {"elevated", integrity > ownIntegrity && ownIntegrity >= 0},
            {"accessKnown", path.Length > 0 && created.Length > 0 && integrity >= 0 && ownIntegrity >= 0}, {"dpi", dpi},
            {"interactiveDesktop", String.Equals(desktop, "Default", StringComparison.OrdinalIgnoreCase)}
        };
    }
    static void CheckIdentity(Dictionary<string,object> actual, Dictionary<string,object> expected) {
        if (expected == null) Fail("DRAGON_TARGET_REQUIRED");
        foreach (string key in new [] { "windowId", "pid", "path", "created", "className" })
            if (!String.Equals(Str(actual, key), Str(expected, key), StringComparison.OrdinalIgnoreCase)) Fail("DRAGON_TARGET_CHANGED");
    }
    static bool SameElement(AutomationElement element, Dictionary<string,object> expected) {
        var c = element.Current;
        return Str(expected, "runtimeId") == String.Join(".", element.GetRuntimeId()) &&
            Str(expected, "role") == c.ControlType.ProgrammaticName.Replace("ControlType.", "") &&
            Str(expected, "name") == Limit(c.Name, 300) && Str(expected, "automationId") == Limit(c.AutomationId, 150);
    }
    static List<AutomationElement> Elements(AutomationElement root, out bool truncated) {
        var found = new List<AutomationElement>(); var queue = new Queue<Tuple<AutomationElement,int>>();
        queue.Enqueue(Tuple.Create(root, 0)); truncated = false;
        while (queue.Count > 0 && found.Count < 250) {
            var entry = queue.Dequeue();
            try {
                var element = entry.Item1; var current = element.Current; found.Add(element);
                if (entry.Item2 >= 10) { truncated = true; continue; }
                var walker = TreeWalker.ControlViewWalker; AutomationElement child = walker.GetFirstChild(element);
                while (child != null && queue.Count < 500) {
                    queue.Enqueue(Tuple.Create(child, entry.Item2 + 1)); child = walker.GetNextSibling(child);
                }
                if (queue.Count >= 500) truncated = true;
            } catch (ElementNotAvailableException) { } catch (InvalidOperationException) { }
        }
        truncated = truncated || queue.Count > 0; return found;
    }
    static object Node(AutomationElement element, int index) {
        var c = element.Current; var rect = c.BoundingRectangle;
        var patterns = new List<string>(); object p; string value = "";
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out p)) patterns.Add("invoke");
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
            if (!c.IsPassword) value = Limit(((ValuePattern)p).Current.Value, 400);
            if (!c.IsPassword && !((ValuePattern)p).Current.IsReadOnly) patterns.Add("set_value");
        }
        bool? selected = null, expanded = null; string toggle = null;
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { patterns.Add("select"); selected = ((SelectionItemPattern)p).Current.IsSelected; }
        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { patterns.Add("toggle"); toggle = ((TogglePattern)p).Current.ToggleState.ToString(); }
        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
            patterns.Add("expand"); patterns.Add("collapse"); expanded = ((ExpandCollapsePattern)p).Current.ExpandCollapseState == ExpandCollapseState.Expanded;
        }
        return new {
            id = index, runtimeId = String.Join(".", element.GetRuntimeId()),
            name = Limit(c.Name, 300), role = c.ControlType.ProgrammaticName.Replace("ControlType.", ""),
            automationId = Limit(c.AutomationId, 150), enabled = c.IsEnabled, offscreen = c.IsOffscreen,
            password = c.IsPassword, focused = c.HasKeyboardFocus, value = c.IsPassword ? null : value,
            patterns = patterns, selected = selected, expanded = expanded, toggle = toggle,
            x = rect.IsEmpty ? 0 : rect.X, y = rect.IsEmpty ? 0 : rect.Y,
            width = rect.IsEmpty ? 0 : rect.Width, height = rect.IsEmpty ? 0 : rect.Height
        };
    }
    [STAThread] static int Main(string[] args) {
        try {
            SetProcessDPIAware(); try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
            Dictionary<string,object> request;
            if (args.Length == 1) request = new Dictionary<string,object> { { "windowId", Int64.Parse(args[0]) }, { "op", "tree" } };
            else {
                Console.InputEncoding = new UTF8Encoding(false);
                string input = Console.In.ReadToEnd(); if (input.Length > 131072) Fail("DRAGON_ARGUMENT_LIMIT");
                request = Json.Deserialize<Dictionary<string,object>>(input);
            }
            long id = Convert.ToInt64(Get(request, "windowId")); if (id <= 0) Fail("DRAGON_INVALID_WINDOW");
            string op = Str(request, "op"); var meta = Inspect(id);
            if (op == "inspect") { Emit(meta); return 0; }
            if (!Convert.ToBoolean(Get(meta, "interactiveDesktop"))) Fail("DRAGON_DESKTOP_UNAVAILABLE");
            if (Get(request, "expected") != null) CheckIdentity(meta, Obj(request, "expected"));
            if (!Convert.ToBoolean(Get(meta, "accessKnown"))) Fail("DRAGON_WINDOW_ACCESS_DENIED");
            if (Convert.ToBoolean(Get(meta, "elevated"))) Fail("DRAGON_WINDOW_ELEVATED");
            AutomationElement root = AutomationElement.FromHandle(new IntPtr(id));
            bool truncated; var found = Elements(root, out truncated);
            if (op != "tree") {
                CheckIdentity(meta, Obj(request, "expected"));
                var target = Obj(request, "element"); if (target == null) Fail("DRAGON_TARGET_REQUIRED");
                AutomationElement selected = null;
                foreach (var element in found) try { if (SameElement(element, target)) { if (selected != null) Fail("DRAGON_TARGET_AMBIGUOUS"); selected = element; } } catch (ElementNotAvailableException) { }
                if (selected == null) Fail("DRAGON_ELEMENT_STALE");
                var c = selected.Current;
                if (!c.IsEnabled || c.IsOffscreen) Fail("DRAGON_ELEMENT_UNAVAILABLE");
                if (c.IsPassword) Fail("DRAGON_PASSWORD_HANDOFF");
                CheckIdentity(Inspect(id), Obj(request, "expected")); object pattern;
                if (op == "invoke" && selected.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) ((InvokePattern)pattern).Invoke();
                else if (op == "set_value" && selected.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
                    if (((ValuePattern)pattern).Current.IsReadOnly) Fail("DRAGON_ELEMENT_READ_ONLY");
                    string text = Str(request, "value"); if (text.Length > 16384) Fail("DRAGON_ARGUMENT_LIMIT");
                    ((ValuePattern)pattern).SetValue(text);
                } else if (op == "select" && selected.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) ((SelectionItemPattern)pattern).Select();
                else if (op == "toggle" && selected.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) ((TogglePattern)pattern).Toggle();
                else if ((op == "expand" || op == "collapse") && selected.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) {
                    if (op == "expand") ((ExpandCollapsePattern)pattern).Expand(); else ((ExpandCollapsePattern)pattern).Collapse();
                } else Fail("DRAGON_PATTERN_UNSUPPORTED");
                System.Threading.Thread.Sleep(80);
                if (!IsWindow(new IntPtr(id))) {
                    Emit(new { windowId = id, identity = meta, elements = new object[0], truncated = false, actionAccepted = true, windowClosed = true }); return 0;
                }
                CheckIdentity(Inspect(id), Obj(request, "expected")); found = Elements(root, out truncated);
            }
            var nodes = new List<object>();
            foreach (var element in found) try { nodes.Add(Node(element, nodes.Count)); } catch (ElementNotAvailableException) { } catch (InvalidOperationException) { }
            Emit(new { windowId = id, identity = meta, elements = nodes, truncated = truncated, actionAccepted = op != "tree" }); return 0;
        } catch (Exception error) {
            string message = error.Message; Console.Error.Write(message.StartsWith("DRAGON_") ? message : "DRAGON_UIA_UNAVAILABLE"); return 1;
        }
    }
    static void Emit(object value) { Console.OutputEncoding = new UTF8Encoding(false); Console.Write(Json.Serialize(value)); }
}
