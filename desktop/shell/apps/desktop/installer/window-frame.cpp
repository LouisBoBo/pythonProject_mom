// Keeps the DWM frame and shadow while the NSIS page owns the entire client area.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <tlhelp32.h>
#include <restartmanager.h>
#include <objidl.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <new>
#include "progress.h"
#include "extract.h"
#include "extract-report.h"
#include "directory-report.h"
#include "uninstall-data.h"

using namespace Gdiplus;

// Returns whether the UTF-8 report was saved; failure still presents the original error unless silent.
extern "C" __declspec(dllexport) int __cdecl InstallerReportDirectoryFailure(
    HWND parent, DWORD error, LPCWSTR source, LPCWSTR destination, DWORD restoreError, LPCWSTR backup,
    LPCWSTR log, LPCWSTR reportPath, int show, LPCWSTR title, LPCWSTR heading, LPCWSTR hint, LPCWSTR copy,
    LPCWSTR expand, LPCWSTR collapse, LPCWSTR savedFormat, LPCWSTR unsaved, LPCWSTR copied) {
    try {
        const std::wstring report = directory_report::Compose(error, source, destination, restoreError, backup, extract_report::ReadOutput(log));
        const bool saved = extract_report::WriteUtf8(reportPath, report);
        if (show) {
            std::wstring footer = saved ? savedFormat : unsaved;
            const auto placeholder = footer.find(L"%s");
            if (saved && placeholder != std::wstring::npos) footer.replace(placeholder, 2, reportPath);
            const extract_report::DialogStrings strings{title, heading, copy, expand, collapse, footer.c_str(), copied};
            const std::wstring content = directory_report::Content(error, hint, restoreError, backup);
            extract_report::Show(parent, content, extract_report::BoundedExcerpt(extract_report::Lines(extract_report::Trim(report))), report, strings);
        }
        return saved ? 1 : 0;
    } catch (const std::bad_alloc&) {
        if (show) MessageBoxW(parent, hint, heading, MB_OK | MB_ICONEXCLAMATION);
        return 0;
    }
}

// Saves the extraction failure report and, unless silent, presents its headline with a copy action.
// Returns 1 when the report file was written and 0 otherwise; the dialog outcome never fails the caller.
extern "C" __declspec(dllexport) int __cdecl InstallerReportExtractFailure(
    HWND parent, int code, LPCWSTR archive, LPCWSTR destination, LPCWSTR log, LPCWSTR reportPath, int show,
    LPCWSTR title, LPCWSTR heading, LPCWSTR hint, LPCWSTR copy, LPCWSTR expand, LPCWSTR collapse, LPCWSTR savedFormat, LPCWSTR unsaved, LPCWSTR copied) {
    try {
        const std::wstring output = extract_report::ReadOutput(log);
        const std::wstring report = extract_report::Compose(code, archive, destination, output,
            extract_report::Timestamp(), extract_report::WindowsVersion());
        const bool saved = extract_report::WriteUtf8(reportPath, report);
        if (show) {
            std::wstring footer = saved ? savedFormat : unsaved;
            const auto placeholder = footer.find(L"%s");
            if (saved && placeholder != std::wstring::npos) footer.replace(placeholder, 2, reportPath);
            const extract_report::DialogStrings strings{title, heading, copy, expand, collapse, footer.c_str(), copied};
            const std::wstring content = extract_report::Headline(code, output, archive) + L"\r\n\r\n" + hint;
            extract_report::Show(parent, content, extract_report::Excerpt(report), report, strings);
        }
        return saved ? 1 : 0;
    } catch (const std::bad_alloc&) {
        return 0;
    }
}

// Returns a Win32 error code; no cleanup request may traverse a linked root or touch the protected root.
extern "C" __declspec(dllexport) DWORD __cdecl UninstallRemoveData(LPCWSTR path, LPCWSTR installation, LPCWSTR protectedRoot) {
    return uninstall_data::Remove(path, installation, protectedRoot);
}

// Returns a Win32 error code; only ordinary empty directories strictly below the stop directory are removed.
extern "C" __declspec(dllexport) DWORD __cdecl UninstallRemoveEmptyParents(LPCWSTR path, LPCWSTR stop) {
    return uninstall_data::RemoveEmptyParents(path, stop);
}

// Win32 path with the long name and without a \\?\ prefix or a trailing slash.
static void InstallerCanonicalPath(LPCWSTR input, WCHAR* output, DWORD outputCount) {
    WCHAR longPath[32768];
    DWORD length = GetLongPathNameW(input, longPath, ARRAYSIZE(longPath));
    LPCWSTR value = length > 0 && length < ARRAYSIZE(longPath) ? longPath : input;
    if (wcsncmp(value, L"\\\\?\\", 4) == 0) value += 4;
    lstrcpynW(output, value, static_cast<int>(outputCount));
    size_t end = wcslen(output);
    while (end > 0 && (output[end - 1] == L'\\' || output[end - 1] == L'/')) output[--end] = L'\0';
}

// The running image is this installation when it is the given executable or any
// other file inside that executable's directory. A same-named copy elsewhere is ignored.
static bool InstallerImageInDirectory(LPCWSTR executable, LPCWSTR image) {
    WCHAR expected[32768];
    WCHAR actual[32768];
    InstallerCanonicalPath(executable, expected, ARRAYSIZE(expected));
    InstallerCanonicalPath(image, actual, ARRAYSIZE(actual));
    if (expected[0] == L'\0' || actual[0] == L'\0') return false;
    if (_wcsicmp(expected, actual) == 0) return true;
    WCHAR* slash = wcsrchr(expected, L'\\');
    if (slash == nullptr) return false;
    *slash = L'\0';
    const size_t directory = wcslen(expected);
    if (directory == 0 || _wcsnicmp(actual, expected, directory) != 0) return false;
    return actual[directory] == L'\\';
}

// Ends the Restart Manager session on every return, including allocation failure.
struct InstallerRmSession {
    DWORD value = 0;
    bool open = false;
    ~InstallerRmSession() { if (open) RmEndSession(value); }
    bool start() {
        WCHAR key[CCH_RM_SESSION_KEY + 1] = {};
        if (RmStartSession(&value, 0, key) != ERROR_SUCCESS) return false;
        open = true;
        return true;
    }
};

// Drive roots, the Windows tree, and the shell folders that contain unrelated programs.
// A child of Program Files is a normal install directory and stays eligible.
static bool InstallerProtectedPath(const std::wstring& path) {
    if (path.size() <= 3) return true;
    if (path.size() == 8 && _wcsicmp(path.c_str() + 3, L"Users") == 0) return true;
    WCHAR windows[MAX_PATH];
    const UINT length = GetWindowsDirectoryW(windows, ARRAYSIZE(windows));
    std::wstring windowsDir;
    if (length == 0 || length >= ARRAYSIZE(windows) || !uninstall_data::Normalize(windows, windowsDir)) return true;
    if (uninstall_data::Contains(windowsDir, path) || uninstall_data::Contains(path, windowsDir)) return true;
    const LPCWSTR variables[] = {L"ProgramFiles", L"ProgramFiles(x86)", L"ProgramW6432", L"ProgramData", L"PUBLIC"};
    for (LPCWSTR variable : variables) {
        WCHAR value[MAX_PATH];
        const DWORD count = GetEnvironmentVariableW(variable, value, ARRAYSIZE(value));
        std::wstring folder;
        if (count == 0 || count >= ARRAYSIZE(value) || !uninstall_data::Normalize(value, folder)) continue;
        if (_wcsicmp(path.c_str(), folder.c_str()) == 0 || uninstall_data::Contains(path, folder)) return true;
    }
    return false;
}

static void InstallerRememberFile(const std::wstring& path, std::vector<std::wstring>& files, size_t limit) {
    if (files.size() >= limit) return;
    for (const std::wstring& existing : files) {
        if (_wcsicmp(existing.c_str(), path.c_str()) == 0) return;
    }
    files.push_back(path);
}

// Directory links are not followed: a junction inside the install tree must not
// register files outside it and then become a reason to stop unrelated programs.
static void InstallerCollectFiles(const std::wstring& root, const std::wstring& directory,
    std::vector<std::wstring>& files, size_t limit) {
    if (files.size() >= limit) return;
    std::vector<std::wstring> children;
    {
        struct Find {
            HANDLE value;
            explicit Find(HANDLE found) : value(found) {}
            ~Find() { if (value != INVALID_HANDLE_VALUE) FindClose(value); }
        };
        WIN32_FIND_DATAW data = {};
        const Find found(FindFirstFileW((L"\\\\?\\" + directory + L"\\*").c_str(), &data));
        if (found.value == INVALID_HANDLE_VALUE) return;
        size_t seen = 0;
        do {
            if (++seen > 4096) break;
            if (data.cFileName[0] == L'.' && (data.cFileName[1] == L'\0'
                || (data.cFileName[1] == L'.' && data.cFileName[2] == L'\0'))) continue;
            if ((data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
            const std::wstring path = directory + L"\\" + data.cFileName;
            if (!uninstall_data::Contains(root, path)) continue;
            if ((data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) children.push_back(path);
            else InstallerRememberFile(path, files, limit);
        } while (FindNextFileW(found.value, &data));
    }
    for (const std::wstring& child : children) InstallerCollectFiles(root, child, files, limit);
}

// Only stop a same-session program whose image is outside Windows and the other
// protected roots. Services, Explorer, and critical processes keep their files open.
static int InstallerStopLockingProcesses(const std::vector<RM_PROCESS_INFO>& processes) {
    DWORD selfSession = 0;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &selfSession) || selfSession == 0) return 0;
    const DWORD self = GetCurrentProcessId();
    int stopped = 0;
    for (const RM_PROCESS_INFO& info : processes) {
        switch (info.ApplicationType) {
        case RmService:
        case RmExplorer:
        case RmCritical:
            continue;
        case RmUnknownApp:
        case RmMainWindow:
        case RmOtherWindow:
        case RmConsole:
            break;
        default:
            continue;
        }
        if (info.TSSessionId != selfSession) continue;
        const DWORD pid = static_cast<DWORD>(info.Process.dwProcessId);
        if (pid == 0 || pid == self) continue;
        const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
        if (process == nullptr) continue;
        WCHAR image[32768];
        DWORD count = ARRAYSIZE(image);
        bool allowed = false;
        if (QueryFullProcessImageNameW(process, 0, image, &count)) {
            BOOL critical = FALSE;
            std::wstring path;
            if (!(IsProcessCritical(process, &critical) && critical)
                && uninstall_data::Normalize(image, path) && !InstallerProtectedPath(path)) allowed = true;
        }
        if (allowed && TerminateProcess(process, 1)) {
            WaitForSingleObject(process, 2000);
            stopped += 1;
        }
        CloseHandle(process);
    }
    return stopped;
}

static int InstallerReleaseDirectoryBody(LPCWSTR directory);

// Close ordinary programs holding files in this directory so the directory itself can be renamed.
// Returns how many programs were stopped, or -1 when the lock list cannot be read.
extern "C" __declspec(dllexport) int __cdecl InstallerReleaseDirectory(LPCWSTR directory) {
    if (directory == nullptr || directory[0] == L'\0') return 0;
    try {
        return InstallerReleaseDirectoryBody(directory);
    } catch (const std::bad_alloc&) {
        return -1;
    }
}

static int InstallerReleaseDirectoryBody(LPCWSTR directory) {
    std::wstring root;
    if (!uninstall_data::Normalize(directory, root) || InstallerProtectedPath(root)) return 0;
    const DWORD attributes = GetFileAttributesW((L"\\\\?\\" + root).c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0
        || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return 0;
    std::vector<std::wstring> files;
    const std::wstring asar = root + L"\\resources\\app.asar";
    const DWORD asarAttributes = GetFileAttributesW((L"\\\\?\\" + asar).c_str());
    if (asarAttributes != INVALID_FILE_ATTRIBUTES
        && (asarAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) == 0)
        InstallerRememberFile(asar, files, 256);
    InstallerCollectFiles(root, root, files, 256);
    if (files.empty()) return 0;
    InstallerRmSession session;
    if (!session.start()) return -1;
    std::vector<LPCWSTR> names;
    names.reserve(files.size());
    for (const std::wstring& file : files) names.push_back(file.c_str());
    DWORD result = RmRegisterResources(session.value, static_cast<UINT>(names.size()), names.data(), 0, nullptr, 0, nullptr);
    if (result != ERROR_SUCCESS) return -1;
    UINT needed = 0;
    UINT count = 0;
    DWORD reasons = 0;
    result = RmGetList(session.value, &needed, &count, nullptr, &reasons);
    if (result == ERROR_SUCCESS) return 0;
    if (result != ERROR_MORE_DATA || needed == 0 || needed > 64) return -1;
    std::vector<RM_PROCESS_INFO> processes(needed);
    count = needed;
    result = RmGetList(session.value, &needed, &count, processes.data(), &reasons);
    if (result != ERROR_SUCCESS || count > processes.size()) return -1;
    processes.resize(count);
    return InstallerStopLockingProcesses(processes);
}

// Match the affected executable, not another user's or directory's same-named application.
// Returns 0 while running, 1 when absent, and -1 if the process list cannot be read.
extern "C" __declspec(dllexport) int __cdecl InstallerFindProcess(LPCWSTR executable) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return -1;
    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    int result = 1;
    BOOL present = Process32FirstW(snapshot, &entry);
    while (present) {
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
        if (process) {
            WCHAR path[32768];
            DWORD count = ARRAYSIZE(path);
            if (QueryFullProcessImageNameW(process, 0, path, &count) && InstallerImageInDirectory(executable, path)) result = 0;
            CloseHandle(process);
            if (result == 0) break;
        }
        present = Process32NextW(snapshot, &entry);
    }
    if (!present && GetLastError() != ERROR_NO_MORE_FILES) result = -1;
    CloseHandle(snapshot);
    return result;
}

// Stop processes whose image is inside the installation directory, then wait until they leave.
// Returns 0 when none remain, 1 when one is still running, and -1 if the process list cannot be read.
extern "C" __declspec(dllexport) int __cdecl InstallerCloseApp(LPCWSTR executable) {
    for (int attempt = 0; attempt < 25; ++attempt) {
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE) return -1;
        PROCESSENTRY32W entry = {};
        entry.dwSize = sizeof(entry);
        int running = 0;
        BOOL present = Process32FirstW(snapshot, &entry);
        while (present) {
            HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, entry.th32ProcessID);
            if (process) {
                WCHAR path[32768];
                DWORD count = ARRAYSIZE(path);
                if (QueryFullProcessImageNameW(process, 0, path, &count) && InstallerImageInDirectory(executable, path)) {
                    running = 1;
                    if (TerminateProcess(process, 1)) WaitForSingleObject(process, 500);
                }
                CloseHandle(process);
            }
            present = Process32NextW(snapshot, &entry);
        }
        const DWORD listError = GetLastError();
        CloseHandle(snapshot);
        if (!present && listError != ERROR_NO_MORE_FILES) return -1;
        if (running == 0) return 0;
        Sleep(200);
    }
    return 1;
}

struct ProgressPage {
    InstallProgress progress{GetTickCount64()};
    bool dark;
    UINT dpi;
    ULONG_PTR gdiplus;
    Image* brand;
    WCHAR captions[5][128];
};

// NSIS shows its page after MUI's SHOW callback; keep its controls off screen.
static LRESULT CALLBACK HiddenPageProc(HWND window, UINT message, WPARAM wparam,
                                      LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_WINDOWPOSCHANGING) {
        auto* position = reinterpret_cast<WINDOWPOS*>(lparam);
        position->flags = (position->flags & ~SWP_SHOWWINDOW) | SWP_HIDEWINDOW;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, HiddenPageProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

static void FillProgress(Graphics& graphics, Brush& brush, REAL width) {
    if (width <= 0) return;
    if (width < 4) { graphics.FillRectangle(&brush, 64.0f, 482.0f, width, 6.0f); return; }
    GraphicsPath path;
    path.AddArc(64.0f, 482.0f, 4.0f, 4.0f, 180.0f, 90.0f);
    path.AddArc(64.0f + width - 4, 482.0f, 4.0f, 4.0f, 270.0f, 90.0f);
    path.AddArc(64.0f + width - 4, 484.0f, 4.0f, 4.0f, 0.0f, 90.0f);
    path.AddArc(64.0f, 484.0f, 4.0f, 4.0f, 90.0f, 90.0f);
    path.CloseFigure();
    graphics.FillPath(&brush, &path);
}

static LRESULT CALLBACK ProgressProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_CREATE) {
        page = static_cast<ProgressPage*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(page));
        SetTimer(window, 1, 16, nullptr);
    }
    if (message == WM_ERASEBKGND) return 1;
    if (message == WM_TIMER) { InvalidateRect(window, nullptr, FALSE); return 0; }
    if (message == WM_LBUTTONDOWN && page) {
        const int x = LOWORD(lparam) * 96 / page->dpi;
        const int y = HIWORD(lparam) * 96 / page->dpi;
        if (y < 48) {
            HWND parent = GetParent(window);
            if (x >= 548) PostMessageW(parent, WM_CLOSE, 0, 0);
            else if (x >= 504) ShowWindow(parent, SW_MINIMIZE);
            else { ReleaseCapture(); SendMessageW(parent, WM_NCLBUTTONDOWN, HTCAPTION, 0); }
        }
        return 0;
    }
    if (message == WM_PAINT && page) {
        PAINTSTRUCT paint;
        HDC dc = BeginPaint(window, &paint);
        {
            Bitmap buffer(MulDiv(600, page->dpi, 96), MulDiv(600, page->dpi, 96), PixelFormat32bppPARGB);
            Graphics graphics(&buffer);
            graphics.ScaleTransform(page->dpi / 96.0f, page->dpi / 96.0f);
            graphics.Clear(page->dark ? Color(255, 21, 21, 23) : Color(255, 255, 255, 255));
            graphics.SetSmoothingMode(SmoothingModeAntiAlias);
            graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);
            graphics.SetPixelOffsetMode(PixelOffsetModeHalf);
            graphics.DrawImage(page->brand, Rect(0, 174, 600, 196));
            const int stage = static_cast<int>(reinterpret_cast<INT_PTR>(GetPropW(GetParent(window), L"HarnessInstaller.Stage")));
            const double fraction = reinterpret_cast<UINT_PTR>(GetPropW(GetParent(window), L"HarnessInstaller.ExtractProgress")) / 100.0;
            page->progress.Advance(stage, fraction, GetTickCount64());
            const int percent = static_cast<int>(page->progress.value);
            SolidBrush track(page->dark ? Color(255, 97, 102, 107) : Color(255, 233, 236, 242));
            SolidBrush ink(page->dark ? Color(255, 255, 255, 255) : Color(255, 15, 17, 21));
            FillProgress(graphics, track, 472.0f);
            FillProgress(graphics, ink, 472.0f * static_cast<REAL>(page->progress.value) / 100);
            FontFamily family(L"Microsoft YaHei UI");
            Font font(&family, 14, FontStyleRegular, UnitPixel);
            StringFormat centered;
            centered.SetAlignment(StringAlignmentCenter);
            centered.SetLineAlignment(StringAlignmentCenter);
            WCHAR caption[160];
            wsprintfW(caption, page->captions[page->progress.CaptionStage()], percent);
            SetWindowTextW(window, caption);
            graphics.DrawString(caption, -1, &font, RectF(48, 512, 504, 22), &centered, &ink);
            Font controls(&family, 16, FontStyleRegular, UnitPixel);
            graphics.DrawString(L"\x2212", -1, &controls, RectF(504, 8, 40, 32), &centered, &ink);
            graphics.DrawString(L"\x00d7", -1, &controls, RectF(548, 8, 40, 32), &centered, &ink);
            Graphics screen(dc);
            screen.DrawImage(&buffer, 0, 0);
        }
        EndPaint(window, &paint);
        if (page->progress.value == 100) SetPropW(GetParent(window), L"HarnessInstaller.CompletedPercent", reinterpret_cast<HANDLE>(100));
        return 0;
    }
    if (message == WM_NCDESTROY && page) {
        KillTimer(window, 1);
        delete page->brand;
        GdiplusShutdown(page->gdiplus);
        delete page;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

// Runs on the NSIS UI thread; the stock installation section runs on its worker.
extern "C" __declspec(dllexport) HWND __cdecl InstallerShowProgress(HWND parent, HWND source,
        BOOL dark, UINT dpi, const WCHAR* brand, const WCHAR* preparing, const WCHAR* extracting,
        const WCHAR* copying, const WCHAR* registering, const WCHAR* cleaning) {
    HINSTANCE module = GetModuleHandleW(nullptr);
    WNDCLASSW type = {};
    type.lpfnWndProc = ProgressProc;
    type.hInstance = module;
    type.lpszClassName = L"HarnessInstallerProgress";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassW(&type);
    auto* page = new (std::nothrow) ProgressPage{};
    if (!page) return nullptr;
    GdiplusStartupInput startup;
    if (GdiplusStartup(&page->gdiplus, &startup, nullptr) != Ok) { delete page; return nullptr; }
    HWND stockPage = GetParent(source);
    if (!SetWindowSubclass(stockPage, HiddenPageProc, 1, 0)) {
        GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }
    ShowWindow(stockPage, SW_HIDE);
    page->dark = dark != FALSE;
    page->dpi = dpi;
    const WCHAR* captions[] = {preparing, extracting, copying, registering, cleaning};
    for (int i = 0; i < 5; ++i) lstrcpynW(page->captions[i], captions[i], 128);
    page->brand = new Image(brand);
    if (page->brand->GetLastStatus() != Ok) {
        delete page->brand; GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }
    HWND window = CreateWindowExW(0, type.lpszClassName, L"", WS_CHILD | WS_VISIBLE,
        0, 0, MulDiv(600, dpi, 96), MulDiv(600, dpi, 96), parent, nullptr, module, page);
    if (!window) { delete page->brand; GdiplusShutdown(page->gdiplus); delete page; }
    return window;
}

// NSIS has already reported success. Pump the UI for the bounded final animation,
// including a painted 100% frame, before constructing the interactive finish page.
extern "C" __declspec(dllexport) BOOL __cdecl InstallerFinishProgress(HWND window) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!page) return FALSE;
    const ULONGLONG started = GetTickCount64();
    SetPropW(GetParent(window), L"HarnessInstaller.Succeeded", reinterpret_cast<HANDLE>(1));
    page->progress.Complete(started);
    while (IsWindow(window) && GetTickCount64() - started < 750) {
        MSG message;
        if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) { PostQuitMessage(static_cast<int>(message.wParam)); return FALSE; }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        } else {
            MsgWaitForMultipleObjectsEx(0, nullptr, 16, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }
    }
    if (!IsWindow(window)) return FALSE;
    InvalidateRect(window, nullptr, FALSE);
    UpdateWindow(window);
    return TRUE;
}

static LRESULT CALLBACK FrameProc(HWND window, UINT message, WPARAM wparam,
                                 LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_NCCALCSIZE && wparam) return 0;
    if (message == WM_NCHITTEST) {
        const LRESULT hit = DefSubclassProc(window, message, wparam, lparam);
        // The installer has a fixed size; its page provides the drag area.
        return hit >= HTLEFT && hit <= HTBOTTOMRIGHT ? HTCLIENT : hit;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, FrameProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

extern "C" __declspec(dllexport) HRESULT __cdecl InstallerApplyFrame(HWND window) {
    // NSIS may release its DLL reference before the window receives WM_NCDESTROY.
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                           reinterpret_cast<LPCWSTR>(&FrameProc), &module)) return E_FAIL;
    if (!SetWindowSubclass(window, FrameProc, 1, 0)) return E_FAIL;
    const int stockControls[] = {1, 2, 3, 1028, 1256, 1034, 1035, 1036, 1037, 1038, 1039};
    for (int id : stockControls) {
        HWND child = GetDlgItem(window, id);
        if (child) {
            if (!SetWindowSubclass(child, HiddenPageProc, 1, 0)) return E_FAIL;
            ShowWindow(child, SW_HIDE);
        }
    }
    SetWindowLongW(window, GWL_STYLE, GetWindowLongW(window, GWL_STYLE) | WS_THICKFRAME);
    const DWMNCRENDERINGPOLICY policy = DWMNCRP_ENABLED;
    HRESULT result = DwmSetWindowAttribute(window, DWMWA_NCRENDERING_POLICY, &policy, sizeof(policy));
    if (FAILED(result)) return result;
    const DWORD rounded = 2;
    // Windows 10 does not support the Windows 11 corner preference.
    DwmSetWindowAttribute(window, 33, &rounded, sizeof(rounded));
    const MARGINS margins = {1, 1, 1, 1};
    result = DwmExtendFrameIntoClientArea(window, &margins);
    SetWindowPos(window, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    return result;
}

// Present the first interactive page after resource preparation without keeping the installer topmost.
extern "C" __declspec(dllexport) BOOL __cdecl InstallerPresentWelcome(HWND window) {
    if (!IsWindowVisible(window)) return FALSE;
    if (!SetWindowPos(window, HWND_TOP, 0, 0, 0, 0,
                      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) return FALSE;
    if (GetForegroundWindow() != window) {
        FLASHWINFO flash = {sizeof(flash), window, FLASHW_TRAY | FLASHW_TIMERNOFG, 0, 0};
        FlashWindowEx(&flash);
    }
    SetPropW(window, L"HarnessInstaller.Presented", reinterpret_cast<HANDLE>(1));
    return TRUE;
}
