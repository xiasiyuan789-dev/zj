import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { serveSite } from "./adapter.mjs";
import { handleVault } from "./handler.mjs";

Deno.serve(serveSite(handleVault, {
  createClient,
  env: (name: string) => Deno.env.get(name),
}));
