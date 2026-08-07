// Import z efektem ubocznym: bez niego deklaracje @types/express-session nie
// trafiaja do programu i `req.session` nie istnieje dla kompilatora.
import "express-session";
import type { Site, User, Workspace } from "./db/types";

export interface FlashMessage {
  message: string;
  category: "success" | "error" | "warning" | "info";
}

declare module "express-session" {
  interface SessionData {
    user_id?: number;
    workspace_id?: number;
    oauth_state?: string;
    oauth_next?: string;
    _flashes?: FlashMessage[];
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: User | undefined;
      workspace?: Workspace | undefined;
      site?: Site | undefined;
    }
  }
}

export {};
