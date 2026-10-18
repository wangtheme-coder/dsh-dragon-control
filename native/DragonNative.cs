// DragonNative.exe — 龙爪自立原生层（不依赖 dsh-orb）
// 独立进程，JSON 行协议：stdin 每行一个请求 {id,op,...}，stdout 每行一个响应 {id,ok,value|error}。
// 覆盖：显示器信息、窗口枚举、前台/焦点、截图（PNG）、鼠标、键盘、Unicode 直输、滚动、拖拽、指针位置、提权检查。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

static class DragonNative
{
    // ---------- Win32 ----------
    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_SCANCODE = 0x0008;
    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
               MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010,
               MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040,
               MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000,
               MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x01000;

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool flag);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc proc, IntPtr param);
    delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr param);
    [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int ret);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);

    const int DWMWA_CLOAKED = 14;
    const int GWW_EXSTYLE = -20;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int GWL_STYLE = -16;
    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
    const int TOKEN_QUERY = 0x0008;
    const int TokenElevation = 20;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    static bool elevatedSelf = false;
    // watch 模式用：常驻进程监视 Esc，向 stdout 推事件
    static StreamWriter Stdout;
    static StreamReader InputStream;
    static readonly object EmitLock = new object();
    static volatile bool watchStopped;
    static HookProc hookCallback;
    static IntPtr hookHandle = IntPtr.Zero;
    static bool hookIncludeInjected;
    static bool escapePressed;

    // ---------- 主循环 ----------
    static int Main(string[] args)
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { SetProcessDpiAwareness(2); } catch { } }
        elevatedSelf = IsElevated(Process.GetCurrentProcess().Handle);

        var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        Stdout = output; InputStream = input;
        string line;
        while ((line = input.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            Dictionary<string, object> req;
            try { req = ser.DeserializeObject(line) as Dictionary<string, object>; }
            catch (Exception error) { Reply(output, ser, 0, false, null, "请求不是合法 JSON: " + error.Message); continue; }
            if (req == null) { Reply(output, ser, 0, false, null, "请求必须是对象。"); continue; }
            object idValue;
            req.TryGetValue("id", out idValue);
            long id = idValue == null ? 0 : Convert.ToInt64(idValue);
            string op = Str(req, "op");
            try
            {
                object value = Dispatch(op, req);
                Reply(output, ser, id, true, value, null);
            }
            catch (Exception error) { Reply(output, ser, id, false, null, error.Message); }
        }
        return 0;
    }

    static void Reply(StreamWriter output, JavaScriptSerializer ser, long id, bool ok, object value, string error)
    {
        var payload = new Dictionary<string, object> { { "id", id }, { "ok", ok } };
        if (ok) payload["value"] = value; else payload["error"] = error;
        output.WriteLine(ser.Serialize(payload));
    }

    static object Dispatch(string op, Dictionary<string, object> req)
    {
        switch (op)
        {
            case "ping": return new Dictionary<string, object> { { "pong", true }, { "pid", Process.GetCurrentProcess().Id }, { "elevated", elevatedSelf } };
            case "info": return Monitors();
            case "windows": return Windows();
            case "foreground": return Foreground();
            case "integrity": return Integrity(req);
            case "focus": return Focus(req);
            case "capture": return Capture(req);
            case "pointer": return Pointer();
            case "move": return MoveTo(req);
            case "click": return Click(req);
            case "down": return Button(req, true);
            case "up": return Button(req, false);
            case "scroll": return Scroll(req);
            case "drag": return Drag(req);
            case "hold": return Hold(req);
            case "type": return TypeText(req);
            case "key": return KeyCombo(req);
            case "keydown": return KeyState(req, false);
            case "keyup": return KeyState(req, true);
            case "watch": return Watch(req);
            default: throw new Exception("未知操作: " + op);
        }
    }

    // ---------- 工具 ----------
    static string Str(Dictionary<string, object> req, string key)
    {
        object value;
        if (!req.TryGetValue(key, out value) || value == null) return null;
        return Convert.ToString(value);
    }

    static int Int(Dictionary<string, object> req, string key, int fallback)
    {
        object value;
        if (!req.TryGetValue(key, out value) || value == null) return fallback;
        return Convert.ToInt32(value);
    }

    static bool Bool(Dictionary<string, object> req, string key, bool fallback)
    {
        object value;
        if (!req.TryGetValue(key, out value) || value == null) return fallback;
        return Convert.ToBoolean(value);
    }

    static IntPtr Hwnd(Dictionary<string, object> req)
    {
        int value = Int(req, "hwnd", 0);
        if (value == 0) value = Int(req, "window_id", 0);
        return new IntPtr(value);
    }

    static string ProcessName(uint pid)
    {
        if (pid == 0) return "";
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
    }

    static bool IsElevated(IntPtr process)
    {
        try
        {
            IntPtr token;
            if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return false;
            int elevated, size;
            bool ok = GetTokenInformation(token, TokenElevation, out elevated, sizeof(int), out size);
            CloseHandle(token);
            return ok && elevated != 0;
        }
        catch { return false; }
    }

    static bool ProcessElevated(uint pid)
    {
        if (pid == 0) return false;
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return false;
        try { return IsElevated(handle); } finally { CloseHandle(handle); }
    }

    static Dictionary<string, object> Describe(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        var title = new StringBuilder(1024);
        GetWindowTextW(hwnd, title, title.Capacity);
        var cls = new StringBuilder(512);
        GetClassNameW(hwnd, cls, cls.Capacity);
        RECT rect;
        GetWindowRect(hwnd, out rect);
        int cloaked = 0;
        try { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)); } catch { }
        int ex = 0;
        try { ex = GetWindowLongW(hwnd, GWW_EXSTYLE); } catch { }
        return new Dictionary<string, object> {
            { "hwnd", (int)hwnd.ToInt64() },
            { "pid", (int)pid },
            { "app", ProcessName(pid) },
            { "title", title.ToString() },
            { "className", cls.ToString() },
            { "visible", IsWindowVisible(hwnd) },
            { "minimized", IsIconic(hwnd) },
            { "cloaked", cloaked != 0 },
            { "toolWindow", (ex & WS_EX_TOOLWINDOW) != 0 },
            { "foreground", GetForegroundWindow() == hwnd },
            { "frame", Rect(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top) }
        };
    }

    static Dictionary<string, object> Rect(int x, int y, int width, int height)
    {
        return new Dictionary<string, object> { { "x", x }, { "y", y }, { "width", width }, { "height", height } };
    }

    // ---------- 查询 ----------
    static object Monitors()
    {
        var list = new List<object>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr monitor, IntPtr dc, ref RECT r, IntPtr param)
        {
            var info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfoW(monitor, ref info))
            {
                list.Add(new Dictionary<string, object> {
                    { "index", list.Count },
                    { "primary", (info.dwFlags & 1) != 0 },
                    { "frame", Rect(info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right - info.rcMonitor.Left, info.rcMonitor.Bottom - info.rcMonitor.Top) },
                    { "work", Rect(info.rcWork.Left, info.rcWork.Top, info.rcWork.Right - info.rcWork.Left, info.rcWork.Bottom - info.rcWork.Top) }
                });
            }
            return true;
        }, IntPtr.Zero);
        return new Dictionary<string, object> { { "monitors", list }, { "elevated", elevatedSelf } };
    }

    static object Windows()
    {
        var list = new List<object>();
        EnumWindows(delegate (IntPtr hwnd, IntPtr param)
        {
            if (!IsWindowVisible(hwnd)) return true;
            var info = Describe(hwnd);
            if ((string)info["title"] == "") return true;
            if ((bool)info["cloaked"]) return true;
            list.Add(info);
            return true;
        }, IntPtr.Zero);
        return new Dictionary<string, object> { { "windows", list } };
    }

    static object Foreground()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return new Dictionary<string, object> { { "hwnd", 0 }, { "app", "" }, { "title", "" } };
        return Describe(hwnd);
    }

    static object Integrity(Dictionary<string, object> req)
    {
        IntPtr hwnd = Hwnd(req);
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        bool target = ProcessElevated(pid);
        return new Dictionary<string, object> { { "selfElevated", elevatedSelf }, { "targetElevated", target }, { "blocked", target && !elevatedSelf } };
    }

    static object Focus(Dictionary<string, object> req)
    {
        IntPtr hwnd = Hwnd(req);
        if (!IsWindow(hwnd)) throw new Exception("窗口不存在。");
        if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
        // 标准做法：先 attach 到“当前前台窗口”的输入队列，再 SetForegroundWindow，否则会被系统拒绝。
        IntPtr fg = GetForegroundWindow();
        uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint myThread = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != myThread && AttachThreadInput(myThread, fgThread, true);
        try
        {
            if (!SetForegroundWindow(hwnd))
            {
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
            }
            if (GetForegroundWindow() != hwnd)
            {
                // 最后的兜底：置顶再取消置顶，抢一次前台
                SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
                SetWindowPos(hwnd, new IntPtr(-2), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE);
                SetForegroundWindow(hwnd);
            }
        }
        finally { if (attached) AttachThreadInput(myThread, fgThread, false); }
        Thread.Sleep(80);
        var front = Describe(GetForegroundWindow());
        return new Dictionary<string, object> { { "hwnd", (int)hwnd.ToInt64() }, { "foreground", GetForegroundWindow() == hwnd }, { "front", front } };
    }

    static object Pointer()
    {
        POINT point;
        GetCursorPos(out point);
        return new Dictionary<string, object> { { "x", point.X }, { "y", point.Y } };
    }

    // ---------- 截图 ----------
    static object Capture(Dictionary<string, object> req)
    {
        string path = Str(req, "path");
        if (string.IsNullOrEmpty(path)) throw new Exception("缺少 path。");
        string mode = Str(req, "mode") ?? "window";
        int x = 0, y = 0, width = 0, height = 0;
        Bitmap bitmap = null;
        if (mode == "screen")
        {
            int screen = Int(req, "screen", 0);
            var monitors = Monitors() as Dictionary<string, object>;
            var list = (List<object>)monitors["monitors"];
            if (screen < 0 || screen >= list.Count) throw new Exception("屏幕序号越界。");
            var frame = (Dictionary<string, object>)((Dictionary<string, object>)list[screen])["frame"];
            x = (int)frame["x"]; y = (int)frame["y"]; width = (int)frame["width"]; height = (int)frame["height"];
            bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        }
        else
        {
            IntPtr hwnd = Hwnd(req);
            if (!IsWindow(hwnd)) throw new Exception("窗口不存在。");
            RECT rect;
            GetWindowRect(hwnd, out rect);
            x = rect.Left; y = rect.Top; width = rect.Right - rect.Left; height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) throw new Exception("窗口尺寸无效（可能已最小化）。");
            bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                IntPtr dc = graphics.GetHdc();
                bool printed = false;
                try { printed = PrintWindow(hwnd, dc, 2); } finally { graphics.ReleaseHdc(dc); }
                if (!printed) graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
        }
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
        bitmap.Save(path, ImageFormat.Png);
        bitmap.Dispose();
        return new Dictionary<string, object> { { "path", Path.GetFullPath(path) }, { "width", width }, { "height", height }, { "frame", Rect(x, y, width, height) } };
    }

    // ---------- 输入 ----------
    static void Send(INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length) throw new Exception("输入被系统拒绝（可能目标窗口权限更高）。");
    }

    static INPUT Mouse(uint flags, int dx, int dy, int data)
    {
        var input = new INPUT { type = INPUT_MOUSE };
        input.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = (uint)data, dwFlags = flags, dwExtraInfo = IntPtr.Zero };
        return input;
    }

    static void AbsMove(int x, int y)
    {
        const int W = 65535;
        var monitors = (List<object>)((Dictionary<string, object>)Monitors())["monitors"];
        int minX = int.MaxValue, minY = int.MaxValue, maxX = int.MinValue, maxY = int.MinValue;
        foreach (var entry in monitors)
        {
            var frame = (Dictionary<string, object>)((Dictionary<string, object>)entry)["frame"];
            minX = Math.Min(minX, (int)frame["x"]); minY = Math.Min(minY, (int)frame["y"]);
            maxX = Math.Max(maxX, (int)frame["x"] + (int)frame["width"]); maxY = Math.Max(maxY, (int)frame["y"] + (int)frame["height"]);
        }
        int ax = (int)Math.Round((x - minX) * W / (double)Math.Max(1, maxX - minX));
        int ay = (int)Math.Round((y - minY) * W / (double)Math.Max(1, maxY - minY));
        Send(new[] { Mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0) });
    }

    static uint ButtonFlags(string button, bool down)
    {
        switch ((button ?? "left").ToLowerInvariant())
        {
            case "right": return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
            case "middle": return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
            default: return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        }
    }

    static object MoveTo(Dictionary<string, object> req)
    {
        AbsMove(Int(req, "x", 0), Int(req, "y", 0));
        return Pointer();
    }

    static object Click(Dictionary<string, object> req)
    {
        int x = Int(req, "x", int.MinValue), y = Int(req, "y", int.MinValue);
        if (x != int.MinValue && y != int.MinValue) AbsMove(x, y);
        Thread.Sleep(20);
        string button = Str(req, "button") ?? "left";
        int count = Math.Max(1, Int(req, "count", 1));
        var inputs = new List<INPUT>();
        for (int i = 0; i < count; i++)
        {
            inputs.Add(Mouse(ButtonFlags(button, true), 0, 0, 0));
            inputs.Add(Mouse(ButtonFlags(button, false), 0, 0, 0));
            if (i + 1 < count) Thread.Sleep(60);
        }
        Send(inputs.ToArray());
        return Pointer();
    }

    static object Button(Dictionary<string, object> req, bool down)
    {
        int x = Int(req, "x", int.MinValue), y = Int(req, "y", int.MinValue);
        if (x != int.MinValue && y != int.MinValue) AbsMove(x, y);
        Send(new[] { Mouse(ButtonFlags(Str(req, "button") ?? "left", down), 0, 0, 0) });
        return Pointer();
    }

    static object Scroll(Dictionary<string, object> req)
    {
        int x = Int(req, "x", int.MinValue), y = Int(req, "y", int.MinValue);
        if (x != int.MinValue && y != int.MinValue) { AbsMove(x, y); Thread.Sleep(20); }
        int delta = Int(req, "delta", 0);
        bool horizontal = Bool(req, "horizontal", false);
        if (delta == 0) throw new Exception("delta 不能为 0。");
        Send(new[] { Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, 0, 0, delta) });
        return new Dictionary<string, object> { { "scrolled", delta } };
    }

    static object Drag(Dictionary<string, object> req)
    {
        int fromX = Int(req, "fromX", 0), fromY = Int(req, "fromY", 0), toX = Int(req, "toX", 0), toY = Int(req, "toY", 0);
        int steps = Math.Max(4, Int(req, "steps", 16));
        int duration = Math.Max(60, Int(req, "durationMs", 260));
        AbsMove(fromX, fromY);
        Thread.Sleep(30);
        Send(new[] { Mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0) });
        for (int i = 1; i <= steps; i++)
        {
            AbsMove(fromX + (toX - fromX) * i / steps, fromY + (toY - fromY) * i / steps);
            Thread.Sleep(Math.Max(1, duration / steps));
        }
        Send(new[] { Mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0) });
        return Pointer();
    }

    static object Hold(Dictionary<string, object> req)
    {
        int x = Int(req, "x", int.MinValue), y = Int(req, "y", int.MinValue);
        if (x != int.MinValue && y != int.MinValue) { AbsMove(x, y); Thread.Sleep(20); }
        int ms = Math.Max(20, Int(req, "ms", 300));
        Send(new[] { Mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0) });
        Thread.Sleep(ms);
        Send(new[] { Mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0) });
        return new Dictionary<string, object> { { "held", ms } };
    }

    static void TypeUnit(char unit)
    {
        Send(new[] { KeyInput(0, unit, KEYEVENTF_UNICODE, false) });
        Send(new[] { KeyInput(0, unit, KEYEVENTF_UNICODE, true) });
    }

    static INPUT KeyInput(ushort vk, ushort scan, uint extraFlags, bool up)
    {
        var input = new INPUT { type = INPUT_KEYBOARD };
        input.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = extraFlags | (up ? KEYEVENTF_KEYUP : 0), dwExtraInfo = IntPtr.Zero };
        return input;
    }

    static object TypeText(Dictionary<string, object> req)
    {
        string text = Str(req, "text") ?? "";
        if (text.Length == 0) return new Dictionary<string, object> { { "typed", 0 } };
        var batch = new List<INPUT>();
        foreach (char unit in text)
        {
            batch.Add(KeyInput(0, unit, KEYEVENTF_UNICODE, false));
            batch.Add(KeyInput(0, unit, KEYEVENTF_UNICODE, true));
        }
        // 分块发送，避免超长文本触发驱动层限制
        for (int offset = 0; offset < batch.Count; offset += 400)
        {
            int size = Math.Min(400, batch.Count - offset);
            Send(batch.GetRange(offset, size).ToArray());
            Thread.Sleep(4);
        }
        return new Dictionary<string, object> { { "typed", text.Length } };
    }

    // ---------- Esc 常驻监听 ----------
    delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr extra; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; public uint lPrivate; }

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookExW(int type, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG message, IntPtr hwnd, uint filterMin, uint filterMax);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG message);
    [DllImport("user32.dll")] static extern bool PostThreadMessageW(uint thread, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string module);

    static void Emit(string json)
    {
        lock (EmitLock)
        {
            if (Stdout == null) return;
            try { Stdout.WriteLine(json); Stdout.Flush(); } catch { }
        }
    }

    static IntPtr HookHandler(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            int messageId = message.ToInt32();
            if (messageId == 0x100 || messageId == 0x104)
            {
                var key = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(KBDLLHOOKSTRUCT));
                bool injected = (key.flags & 0x10) != 0;
                if (key.vkCode == 0x1B && (hookIncludeInjected || !injected))
                {
                    if (!escapePressed) { escapePressed = true; Emit("{\"event\":\"escape\"}"); }
                }
                else if (!escapePressed) { escapePressed = false; }
            }
            else if (messageId == 0x101 || messageId == 0x105)
            {
                var key = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(KBDLLHOOKSTRUCT));
                if (key.vkCode == 0x1B) escapePressed = false;
            }
        }
        return CallNextHookEx(hookHandle, code, message, data);
    }

    static void HookThread()
    {
        hookCallback = HookHandler;
        hookHandle = SetWindowsHookExW(13, hookCallback, GetModuleHandleW(null), 0);
        if (hookHandle == IntPtr.Zero)
        {
            Emit("{\"event\":\"error\",\"message\":\"无法注册 Windows Esc 急停监听。\"}");
            return;
        }
        Emit("{\"event\":\"ready\"}");
        MSG message;
        while (!watchStopped)
        {
            if (GetMessageW(out message, IntPtr.Zero, 0, 0) <= 0) break;
            TranslateMessage(ref message);
            DispatchMessageW(ref message);
        }
        UnhookWindowsHookEx(hookHandle);
        hookHandle = IntPtr.Zero;
    }

    static object Watch(Dictionary<string, object> req)
    {
        hookIncludeInjected = Bool(req, "includeInjected", false);
        var thread = new Thread(HookThread) { IsBackground = true, Name = "dragon-escape-hook" };
        thread.Start();
        // 主线程只等父进程关闭 stdin（dispose），期间不占用 CPU。
        while (InputStream != null && InputStream.ReadLine() != null) { }
        watchStopped = true;
        PostThreadMessageW((uint)thread.ManagedThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
        thread.Join(500);
        return new Dictionary<string, object> { { "stopped", true } };
    }

    static object KeyState(Dictionary<string, object> req, bool up)
    {
        string name = Str(req, "key");
        if (string.IsNullOrEmpty(name)) throw new Exception("缺少 key。");
        ushort vk = VkOf(name);
        ushort scan = (ushort)MapVirtualKeyW(vk, 0);
        uint extra = Array.IndexOf(ExtendedKeys, vk) >= 0 ? KEYEVENTF_EXTENDEDKEY : 0;
        Send(new[] { KeyInput(vk, scan, extra | KEYEVENTF_SCANCODE, up) });
        return new Dictionary<string, object> { { "key", name }, { "down", !up } };
    }

    static ushort VkOf(string name)
    {
        string key = name.Trim().ToUpperInvariant();
        switch (key)
        {
            case "CTRL": case "CONTROL": return 0x11;
            case "SHIFT": return 0x10;
            case "ALT": return 0x12;
            case "WIN": case "LWIN": return 0x5B;
            case "ENTER": case "RETURN": return 0x0D;
            case "TAB": return 0x09;
            case "ESC": case "ESCAPE": return 0x1B;
            case "SPACE": return 0x20;
            case "BACKSPACE": case "BACK": return 0x08;
            case "DELETE": case "DEL": return 0x2E;
            case "INSERT": return 0x2D;
            case "HOME": return 0x24;
            case "END": return 0x23;
            case "PAGEUP": case "PGUP": return 0x21;
            case "PAGEDOWN": case "PGDN": return 0x22;
            case "UP": return 0x26;
            case "DOWN": return 0x28;
            case "LEFT": return 0x25;
            case "RIGHT": return 0x27;
            case "CAPSLOCK": return 0x14;
            case "PRINTSCREEN": return 0x2C;
        }
        if (key.Length == 1)
        {
            char ch = key[0];
            if (ch >= 'A' && ch <= 'Z') return (ushort)ch;
            if (ch >= '0' && ch <= '9') return (ushort)ch;
        }
        if (key.StartsWith("F") && key.Length <= 3)
        {
            int index;
            if (int.TryParse(key.Substring(1), out index) && index >= 1 && index <= 24) return (ushort)(0x70 + index - 1);
        }
        throw new Exception("无法识别的按键: " + name);
    }

    static readonly ushort[] ExtendedKeys = new ushort[] {
        0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5B, 0x5C, 0x2C, 0xA3, 0xA5
    };

    static object KeyCombo(Dictionary<string, object> req)
    {
        var names = new List<string>();
        object raw = req.ContainsKey("keys") ? req["keys"] : null;
        var array = raw as object[];
        if (array != null) { foreach (object entry in array) names.Add(Convert.ToString(entry)); }
        else if (raw is System.Collections.ArrayList) { foreach (object entry in (System.Collections.ArrayList)raw) names.Add(Convert.ToString(entry)); }
        else if (!string.IsNullOrEmpty(Str(req, "key"))) names.AddRange((Str(req, "key")).Split('+'));
        if (names.Count == 0) throw new Exception("缺少 keys。");
        var downs = new List<INPUT>();
        var ups = new List<INPUT>();
        foreach (string name in names)
        {
            ushort vk = VkOf(name);
            ushort scan = (ushort)MapVirtualKeyW(vk, 0);
            uint extra = Array.IndexOf(ExtendedKeys, vk) >= 0 ? KEYEVENTF_EXTENDEDKEY : 0;
            downs.Add(KeyInput(vk, scan, extra | KEYEVENTF_SCANCODE, false));
            ups.Insert(0, KeyInput(vk, scan, extra | KEYEVENTF_SCANCODE, true));
        }
        var batch = new List<INPUT>(downs);
        batch.AddRange(ups);
        Send(batch.ToArray());
        return new Dictionary<string, object> { { "pressed", names } };
    }
}
