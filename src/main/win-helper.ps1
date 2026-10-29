param(
  [Parameter(Mandatory=$true)][ValidateSet('list','focus','rect','raise','paste','deliver')][string]$Action,
  [string]$OutFile,
  [string]$Hwnd,
  [string]$Mode = 'topmost',
  [string]$ClickOffset,
  [string]$ClickXPercent
)

$ErrorActionPreference = 'Stop'

$csharp = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class WinInfo {
    public long hwnd;
    public string handle;
    public string title;
    public string process;
    public int pid;
    public int x;
    public int y;
    public int w;
    public int h;
    public bool iconic;
    public bool foreground;
    public string monitor;
}

public class FdhWin {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int nMax);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_SHOWWINDOW = 0x0040;
    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO mi);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    public static extern int GetWindowLongW(IntPtr hWnd, int index);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT val, int size);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int val, int size);

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const int DWMWA_CLOAKED = 14;

    public static void InitDpi() {
        try { SetProcessDPIAware(); } catch (Exception) { }
    }

    static string Title(IntPtr h) {
        int len = GetWindowTextLengthW(h);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static bool Cloaked(IntPtr h) {
        try {
            int v;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, 4) == 0) return v != 0;
        } catch (Exception) { }
        return false;
    }

    static long ExStyle(IntPtr h) {
        if (IntPtr.Size == 8) return GetWindowLongPtrW(h, GWL_EXSTYLE).ToInt64();
        return (long)GetWindowLongW(h, GWL_EXSTYLE);
    }

    // Prefer DWM extended frame bounds: it excludes the invisible resize border.
    public static bool VisibleRect(IntPtr h, out RECT r) {
        r = new RECT();
        RECT d;
        if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out d, Marshal.SizeOf(typeof(RECT))) == 0
            && d.Right > d.Left && d.Bottom > d.Top) {
            r = d;
            return true;
        }
        return GetWindowRect(h, out r);
    }

    static string ProcName(uint pid) {
        try { return Process.GetProcessById((int)pid).ProcessName + ".exe"; }
        catch (Exception) { return ""; }
    }

    static string MonitorName(IntPtr h) {
        try {
            IntPtr mon = MonitorFromWindow(h, 2);
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfoW(mon, ref mi)) {
                return mi.rcMonitor.Left + "," + mi.rcMonitor.Top + "," + mi.rcMonitor.Right + "," + mi.rcMonitor.Bottom;
            }
        } catch (Exception) { }
        return "";
    }

    public static List<WinInfo> ListWindows() {
        InitDpi();
        List<WinInfo> list = new List<WinInfo>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            try {
                if (!IsWindowVisible(h)) return true;
                string t = Title(h);
                if (t == null) t = "";
                t = t.Trim();
                if (t.Length == 0) return true;
                if ((ExStyle(h) & WS_EX_TOOLWINDOW) != 0) return true;
                if (Cloaked(h)) return true;
                RECT r;
                if (!VisibleRect(h, out r)) return true;
                int w = r.Right - r.Left;
                int hh = r.Bottom - r.Top;
                if (w < 40 || hh < 40) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                WinInfo wi = new WinInfo();
                wi.hwnd = h.ToInt64();
                wi.handle = "0x" + h.ToInt64().ToString("x");
                wi.title = t;
                wi.pid = (int)pid;
                wi.process = ProcName(pid);
                wi.x = r.Left;
                wi.y = r.Top;
                wi.w = w;
                wi.h = hh;
                wi.iconic = IsIconic(h);
                wi.foreground = (h == fg);
                wi.monitor = MonitorName(h);
                list.Add(wi);
            } catch (Exception) { }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static bool ForceForeground(IntPtr h) {
        InitDpi();
        try {
            if (IsIconic(h)) ShowWindow(h, 9);
            IntPtr fg = GetForegroundWindow();
            uint fgPid;
            uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
            uint cur = GetCurrentThreadId();
            bool attached = false;
            if (fgThread != 0 && fgThread != cur) attached = AttachThreadInput(cur, fgThread, true);
            if (IsIconic(h)) ShowWindow(h, 9); else ShowWindow(h, 5);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            if (attached) AttachThreadInput(cur, fgThread, false);
            // Deliberately NO synthetic keystrokes: sending input into other applications
            // can disturb them. Only z-order changes and retries; failure is reported.
            for (int attempt = 0; attempt < 5; attempt++) {
                if (GetForegroundWindow() == h) return true;
                SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                SetForegroundWindow(h);
                for (int i = 0; i < 12; i++) {
                    if (GetForegroundWindow() == h) return true;
                    System.Threading.Thread.Sleep(10);
                }
            }
            return false;
        } catch (Exception) { return false; }
    }

    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    public static void ClickAt(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(70);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);   // left down
        System.Threading.Thread.Sleep(50);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);   // left up
    }

    // One continuous hand-off: bring the target forward, click into its composer area,
    // paste the clipboard and press Enter. Cursor is restored afterwards.
    public static bool Deliver(IntPtr h, int clickOffsetFromBottom, int composerXPercent) {
        POINT saved;
        GetCursorPos(out saved);
        try {
            if (!ForceForeground(h)) return false;
            System.Threading.Thread.Sleep(300);
            RECT r;
            if (!VisibleRect(h, out r)) return false;
            int w = r.Right - r.Left;
            int hh = r.Bottom - r.Top;
            if (w < 200 || hh < 200) return false;
            int cx = r.Left + (w * composerXPercent) / 100;
            int cy = r.Bottom - clickOffsetFromBottom;
            ClickAt(cx, cy);
            System.Threading.Thread.Sleep(220);
            return SendPasteAndEnter(320);
        } finally {
            SetCursorPos(saved.X, saved.Y);
        }
    }

    // Send Ctrl+V then Enter into the foreground window. Used only when the user explicitly
    // asks the app to hand a task to the DSH window (never on background operations).
    public static bool SendPasteAndEnter(int delayMs) {
        try {
            keybd_event(0x11, 0, 0, UIntPtr.Zero);            // Ctrl down
            System.Threading.Thread.Sleep(40);
            keybd_event(0x56, 0, 0, UIntPtr.Zero);            // V down
            System.Threading.Thread.Sleep(40);
            keybd_event(0x56, 0, 2, UIntPtr.Zero);            // V up
            keybd_event(0x11, 0, 2, UIntPtr.Zero);            // Ctrl up
            System.Threading.Thread.Sleep(delayMs > 0 ? delayMs : 260);
            keybd_event(0x0D, 0, 0, UIntPtr.Zero);            // Enter down
            System.Threading.Thread.Sleep(60);
            keybd_event(0x0D, 0, 2, UIntPtr.Zero);            // Enter up
            return true;
        } catch (Exception) { return false; }
    }

    // Temporarily change z-order only (SWP_NOACTIVATE): never steals focus, never sends input.
    public static bool Raise(IntPtr h, bool topmost) {
        InitDpi();
        try {
            uint flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | 0x0010; // + SWP_NOACTIVATE
            IntPtr after = topmost ? new IntPtr(-1) : new IntPtr(-2);       // HWND_TOPMOST / HWND_NOTOPMOST
            return SetWindowPos(h, after, 0, 0, 0, 0, flags);
        } catch (Exception) { return false; }
    }

    public static WinInfo Describe(IntPtr h) {
        InitDpi();
        WinInfo wi = new WinInfo();
        RECT r;
        if (!VisibleRect(h, out r)) return null;
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        wi.hwnd = h.ToInt64();
        wi.handle = "0x" + h.ToInt64().ToString("x");
        wi.title = Title(h).Trim();
        wi.pid = (int)pid;
        wi.process = ProcName(pid);
        wi.x = r.Left; wi.y = r.Top;
        wi.w = r.Right - r.Left; wi.h = r.Bottom - r.Top;
        wi.iconic = IsIconic(h);
        wi.foreground = GetForegroundWindow() == h;
        wi.monitor = MonitorName(h);
        return wi;
    }
}
"@

Add-Type -TypeDefinition $csharp -Language CSharp

function To-Handle([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { throw "Hwnd argument is required" }
  $t = $s.Trim()
  if ($t.StartsWith('0x') -or $t.StartsWith('0X')) { return [IntPtr]([Int64]::Parse($t.Substring(2), [System.Globalization.NumberStyles]::HexNumber)) }
  return [IntPtr]([Int64]$t)
}

$result = @{}
try {
  if ($Action -eq 'list') {
    $wins = [FdhWin]::ListWindows()
    $result = @{ ok = $true; windows = @($wins); count = $wins.Count }
  }
  elseif ($Action -eq 'focus') {
    $h = To-Handle $Hwnd
    $ok = [FdhWin]::ForceForeground($h)
    $info = [FdhWin]::Describe($h)
    $result = @{ ok = [bool]$ok; window = $info }
  }
  elseif ($Action -eq 'raise') {
    $h = To-Handle $Hwnd
    $top = ($Mode -eq 'topmost')
    $ok = [FdhWin]::Raise($h, $top)
    $result = @{ ok = [bool]$ok; topmost = $top; window = [FdhWin]::Describe($h) }
  }
  elseif ($Action -eq 'deliver') {
    $h = To-Handle $Hwnd
    $off = if ($ClickOffset) { [int]$ClickOffset } else { 96 }
    $xp = if ($ClickXPercent) { [int]$ClickXPercent } else { 50 }
    $ok = [FdhWin]::Deliver($h, $off, $xp)
    $result = @{ ok = [bool]$ok; clicked = [bool]$ok; window = [FdhWin]::Describe($h) }
  }
  elseif ($Action -eq 'paste') {
    $h = To-Handle $Hwnd
    $ok = [FdhWin]::ForceForeground($h)
    if (-not $ok) { throw "Cannot bring target window to foreground" }
    Start-Sleep -Milliseconds 220
    $sent = [FdhWin]::SendPasteAndEnter(300)
    $result = @{ ok = [bool]$sent; focused = [bool]$ok; window = [FdhWin]::Describe($h) }
  }
  elseif ($Action -eq 'rect') {
    $h = To-Handle $Hwnd
    $info = [FdhWin]::Describe($h)
    if ($null -eq $info) { throw "Window not found or not measurable" }
    $result = @{ ok = $true; window = $info }
  }
} catch {
  $result = @{ ok = $false; error = $_.Exception.Message }
}

$json = ConvertTo-Json -InputObject $result -Depth 6 -Compress
if ([string]::IsNullOrWhiteSpace($OutFile)) {
  [Console]::Out.Write($json)
} else {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutFile, $json, $enc)
}