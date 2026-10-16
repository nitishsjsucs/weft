"use client";
// "Viewing as" (a demo control) as the last segment of the environment pill: a Radix DropdownMenu with one radio item
// per demo human, grouped by role, then the new-hire portal personas (research/wave3/topbar-design.md 5.6, D7).
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@weft/ui/components";
import { cn } from "@weft/ui";
import { TID, type W2OnboardingOfferDetail } from "@weft/contracts";
import { PRINCIPALS, setPrincipal, useGet, usePrincipal } from "@/lib/api/hooks";
import { firstName, groupPersonas, initials, roleLabel } from "./env";
import { segmentClass } from "./segment";

/** New-hire personas from sent, viewed or accepted offers. They sign in to the portal only (PORTAL_ONLY elsewhere). */
function usePortalPersonas(): { id: string; name: string }[] {
  const offers = useGet("/v1/offers", { query: { limit: 100 }, refreshMs: 15_000 });
  const rows = (offers.data?.data ?? []) as unknown as W2OnboardingOfferDetail[];
  return rows
    .filter((o) => o.personaPrincipalId && (o.status === "sent" || o.status === "viewed" || o.status === "accepted"))
    .map((o) => ({ id: o.personaPrincipalId!, name: `${o.candidateFirst} ${o.candidateLast}` }));
}

/** The 20 px amber initials avatar: amber marks a demo affordance, as the mock-data banner does. */
export function PersonaAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden data-avatar="" className={cn("grid size-5 shrink-0 place-items-center rounded-full bg-[var(--demo-bg)] text-[10px] leading-none font-semibold text-[var(--demo-fg)]", className)}>
      {initials(name)}
    </span>
  );
}

export function PersonaMenu() {
  const who = usePrincipal();
  const portal = usePortalPersonas();
  const current = PRINCIPALS.find((p) => p.id === who) ?? PRINCIPALS[0];
  const first = firstName(current.name);
  const groups = groupPersonas(PRINCIPALS);

  // Announce a switch to screen readers (the trigger's visible text shrinks in narrow tiers).
  const [said, setSaid] = useState("");
  const prev = useRef(current.id);
  useEffect(() => {
    if (prev.current !== current.id) setSaid(`Now viewing as ${current.name}`);
    prev.current = current.id;
  }, [current.id, current.name]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={TID.viewingAs}
          data-seg=""
          aria-label={`Viewing as ${current.name}. Demo control: switches the signed-in human, dev auth only`}
          className={cn(segmentClass, "w-7 justify-center px-0 @min-[480px]:w-auto @min-[480px]:justify-start @min-[480px]:pr-2 @min-[480px]:pl-1")}
        >
          <PersonaAvatar name={current.name} />
          <span className="hidden font-normal text-gray-11 @min-[760px]:inline">Viewing as</span>
          <span className="hidden @min-[480px]:inline">{first}</span>
          <ChevronDown aria-hidden strokeWidth={1.5} className="hidden size-3.5 text-gray-10 @min-[480px]:block" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(340px,calc(100vw-24px))]">
          <DropdownMenuLabel>Viewing as (demo control)</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={current.id} onValueChange={(v) => setPrincipal(v)}>
            {groups.map((g) => (
              <DropdownMenuGroup key={g.group} aria-label={g.group}>
                {groups.length > 1 ? <DropdownMenuLabel className="pt-2 text-0 text-gray-10">{g.group}</DropdownMenuLabel> : null}
                {g.people.map((p) => (
                  <DropdownMenuRadioItem key={p.id} value={p.id} data-persona={p.id}>
                    <PersonaAvatar name={p.name} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="truncate text-1 text-gray-11">{p.title}, {roleLabel(p.role)}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuRadioGroup>
          {portal.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup aria-label="New-hire portal">
                <DropdownMenuLabel>New-hire portal</DropdownMenuLabel>
                {portal.map((p) => (
                  <DropdownMenuItem key={p.id} data-persona={`portal:${p.id}`} onSelect={() => window.location.assign(`/portal?as=${encodeURIComponent(p.id)}`)}>
                    <PersonaAvatar name={p.name} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="truncate text-1 text-gray-11">Opens the portal as this new hire</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <p className="px-2 pt-1 pb-1.5 text-1 text-gray-11">
            Switches the signed-in human. Dev auth only, and self-approval checks treat each persona as a different person on purpose.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" aria-live="polite">{said}</span>
    </>
  );
}
