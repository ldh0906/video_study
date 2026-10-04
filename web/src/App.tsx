import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, Outlet } from "react-router";
import { Monitor, Moon, Settings2, Sun } from "lucide-react";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Button, Menu, MenuItem, Tooltip } from "@/components/ui";

type Theme = "light" | "dark" | "system";

const SettingsContext = createContext<(section?: "models" | "connection" | "transcription" | "processing" | "tools") => void>(() => {});
export const useOpenSettings = () => useContext(SettingsContext);

function applyTheme(t: Theme) {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="var(--accent-fg)" strokeWidth="2.4" />
      <circle cx="16" cy="16" r="2.6" fill="var(--accent-fg)" />
    </svg>
  );
}

export function ThemeMenu() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {}
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <Menu
      trigger={
        <Button variant="ghost" size="icon" aria-label="테마">
          <Icon className="size-[18px]" />
        </Button>
      }
    >
      <MenuItem icon={<Sun />} onSelect={() => setTheme("light")}>
        라이트
      </MenuItem>
      <MenuItem icon={<Moon />} onSelect={() => setTheme("dark")}>
        다크
      </MenuItem>
      <MenuItem icon={<Monitor />} onSelect={() => setTheme("system")}>
        시스템 설정
      </MenuItem>
    </Menu>
  );
}

export function AppShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<"models" | "connection" | "transcription" | "processing" | "tools">("models");
  const open = (s: typeof section = "models") => {
    setSection(s);
    setSettingsOpen(true);
  };
  return (
    <SettingsContext.Provider value={open}>
      <Outlet />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initial={section} />
    </SettingsContext.Provider>
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  const openSettings = useOpenSettings();
  return (
    <header className="sticky top-0 z-30 border-b border-transparent bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-[1180px] items-center gap-3 px-4 sm:px-8">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo className="size-7" />
          <span className="text-[15px] font-semibold tracking-tight">Lecture Lens</span>
        </Link>
        <div className="flex-1">{children}</div>
        <ThemeMenu />
        <Tooltip content="설정">
          <Button variant="ghost" size="icon" onClick={() => openSettings()} aria-label="설정">
            <Settings2 className="size-[18px]" />
          </Button>
        </Tooltip>
      </div>
    </header>
  );
}
