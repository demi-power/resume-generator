import { useState, useEffect, useCallback } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Briefcase, User, Users, FileText, Sparkles, Sun, Moon, LogOut, FolderOpen } from "lucide-react";
import { cn } from "../lib/utils";
import { useAuth } from "../lib/auth-context";
import { getBaseUrl, getAuthToken } from "../api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";

const SERVER_CHECK_INTERVAL_MS = 10_000;

const THEME_KEY = "resume-builder-desktop-theme";

function useTheme() {
  const [theme, setThemeState] = useState<"light" | "dark">("light");
  useEffect(() => {
    const stored = (localStorage.getItem(THEME_KEY) || "light") as "light" | "dark";
    setThemeState(stored);
    document.documentElement.classList.toggle("dark", stored === "dark");
  }, []);
  const setTheme = (v: "light" | "dark") => {
    setThemeState(v);
    localStorage.setItem(THEME_KEY, v);
    document.documentElement.classList.toggle("dark", v === "dark");
  };
  return { theme, setTheme };
}

type NavItem = { path: string; label: string; icon: React.ReactNode; adminOnly?: boolean };

function getElectronSavePathApi(): {
  getDefaultSavePath: () => Promise<string>;
  setDefaultSavePath: (path: string) => Promise<void>;
  showSavePathDialog: () => Promise<string | null>;
} | null {
  const w = typeof window !== "undefined" ? (window as unknown as { electron?: unknown }) : undefined;
  const e = w?.electron as { getDefaultSavePath?: () => Promise<string>; setDefaultSavePath?: (p: string) => Promise<void>; showSavePathDialog?: () => Promise<string | null> } | undefined;
  if (e?.getDefaultSavePath && e?.setDefaultSavePath && e?.showSavePathDialog) return e as typeof e & { getDefaultSavePath: () => Promise<string>; setDefaultSavePath: (p: string) => Promise<void>; showSavePathDialog: () => Promise<string | null> };
  return null;
}

export function AppHeader() {
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [fileSaveModalOpen, setFileSaveModalOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [connected, setConnected] = useState(false);
  const electronSavePath = getElectronSavePathApi();

  const checkServer = useCallback(async () => {
    try {
      const token = getAuthToken();
      const res = await fetch(`${getBaseUrl()}/api/auth/me`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      setConnected(res.ok);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    checkServer();
    const id = setInterval(checkServer, SERVER_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [checkServer]);

  const navItems: NavItem[] = [
    { path: "/profile", label: "Profile", icon: <User className="h-4 w-4" /> },
    { path: "/template/format1", label: "Templates", icon: <FileText className="h-4 w-4" />, adminOnly: true },
    { path: "/ai", label: "AI", icon: <Sparkles className="h-4 w-4" />, adminOnly: true },
    { path: "/pipeline", label: "Pipeline", icon: <FolderOpen className="h-4 w-4" />, adminOnly: true },
    { path: "/applications", label: "Application", icon: <Briefcase className="h-4 w-4" /> },
    { path: "/users", label: "Users", icon: <Users className="h-4 w-4" />, adminOnly: true },
  ];

  const visibleNavItems = navItems.filter((item) => !item.adminOnly || user?.role === "admin");

  const handleLogout = () => {
    logout();
    setUserMenuOpen(false);
    navigate("/", { replace: true });
  };

  const openFileSaveModal = useCallback(() => {
    setUserMenuOpen(false);
    if (electronSavePath) {
      electronSavePath.getDefaultSavePath().then(setSavePath);
      setFileSaveModalOpen(true);
    }
  }, [electronSavePath]);

  const handleBrowseSavePath = useCallback(async () => {
    if (!electronSavePath) return;
    const chosen = await electronSavePath.showSavePathDialog();
    if (chosen) {
      await electronSavePath.setDefaultSavePath(chosen);
      setSavePath(chosen);
    }
  }, [electronSavePath]);

  return (
    <nav className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center px-4 gap-4">
        <NavLink
          to="/"
          className={({ isActive }) =>
            cn(
              "mr-2 flex items-center gap-2 font-semibold transition-colors hover:text-primary",
              isActive ? "text-foreground" : "text-muted-foreground"
            )
          }
        >
          <Briefcase className="h-5 w-5" />
          <span className="hidden sm:inline">Tailor</span>
        </NavLink>
        <div className="flex flex-1 items-center gap-1">
          {visibleNavItems.map(({ path, label, icon }) => (
            <NavLink
              key={path}
              to={path}
              end={path === "/applications"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )
              }
            >
              {icon}
              {label}
            </NavLink>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex h-2 w-2 shrink-0 rounded-full",
              connected ? "bg-green-500 dark:bg-green-400" : "bg-muted-foreground/60"
            )}
            title={connected ? "Server connected" : "Server disconnected"}
            aria-label={connected ? "Server connected" : "Server disconnected"}
          />
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenuOpen((o) => !o)}
              className="inline-flex items-center gap-2 rounded-full px-2 py-1.5 text-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold"
                aria-hidden
              >
                {(user?.username ?? "U").charAt(0).toUpperCase()}
              </span>
              <span className="text-muted-foreground">{user?.username ?? "User"}</span>
            </button>
            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" aria-hidden onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border bg-popover py-1 shadow-md">
                  {electronSavePath && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                      onClick={openFileSaveModal}
                    >
                      <FolderOpen className="h-4 w-4" />
                      File save
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                    onClick={handleLogout}
                  >
                    <LogOut className="h-4 w-4" />
                    Log out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <Dialog open={fileSaveModalOpen} onOpenChange={setFileSaveModalOpen}>
        <DialogContent noZoomAnimation className="max-w-lg">
          <DialogHeader>
            <DialogTitle>File save location</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Resume PDFs and copied files will be saved to this folder.</p>
          <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm break-all">
            {savePath || "—"}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleBrowseSavePath}>
              <FolderOpen className="h-4 w-4 mr-2" />
              Browse
            </Button>
            <Button onClick={() => setFileSaveModalOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </nav>
  );
}
