# The UI template

We are not designing from scratch. Prism installs a free template, and everyone
else builds screens out of its components.

## What we use

**[shadcn/ui](https://ui.shadcn.com)** — MIT licensed, free forever, no account.

It is not a dependency you install and import. You run a command and it copies
the component's source code into your own repository. That matters for a team
project for two reasons: there is no version to fight over, and when you need a
notification item to look slightly different, you edit your own file instead of
fighting a library's props.

It gives us, already built and accessible:

| We need | shadcn/ui component |
|---|---|
| Bell with unread badge | `button` + `badge` |
| Notification panel | `popover` or `dropdown-menu` + `scroll-area` |
| Notification rows | `separator`, `avatar`, `skeleton` for loading |
| Live toasts | `sonner` — stacking, auto-dismiss and swipe already handled |
| Preferences grid | `switch`, `label`, `card`, `table` |
| Quiet hours | `select`, `popover` |
| Empty and error states | `alert` |
| Forms and validation | `form` + react-hook-form + zod |

Sonner alone saves Pulse a couple of days: stacked toasts that do not overlap is
a fiddly thing to build well, and it is one import here.

## Plus a page layout

shadcn/ui gives components, not whole pages. For the app shell — sidebar, top
bar, responsive layout — Prism takes the layout from
**[TailAdmin's free React dashboard](https://github.com/TailAdmin/free-react-tailwind-admin-dashboard)**
(MIT licensed, free, open source) and strips it down to what we need.

Take the shell only. Do not drag in its chart pages, tables and widgets — they
are demo content and will slow the build down.

## If the team prefers something else

Any of these are free and would also work. Decide once, in the Stage 2 issue,
and do not revisit it:

| Option | Licence | Good if |
|---|---|---|
| [Mantine](https://mantine.dev) | MIT | You want a notifications system built into the library itself — `@mantine/notifications` is close to what we are building |
| [Ant Design](https://ant.design) | MIT | You want the most components out of the box, including `Badge`, `List` and `notification` |
| [HeroUI](https://www.heroui.com) | MIT | You want something modern with animation built in |
| [Flowbite](https://flowbite.com) | MIT (free tier) | You are more comfortable in plain Tailwind than in React component APIs |

I recommend shadcn/ui plus the TailAdmin shell because the code lands in our own
repository, so seven people can read and change it without anyone hitting a wall
the library will not let them past.

## Setup, once, by Prism

```bash
cd frontend
npm create vite@latest . -- --template react-ts
npm install tailwindcss @tailwindcss/vite
npx shadcn@latest init
npx shadcn@latest add button badge popover dropdown-menu scroll-area \
  separator skeleton sonner switch label card select alert form table avatar
```

Then commit it. From that point Pulse and Beacon import from
`@/components/ui/...` and never install a UI package again.

## The rule that replaces having a designer

Nobody hand-rolls a component that shadcn/ui already has, and nobody writes a
raw hex colour. Use the theme tokens (`bg-background`, `text-muted-foreground`,
`border`) so dark mode works everywhere without anyone thinking about it.

If a screen needs something the template does not have, it goes in
`src/components` and Prism reviews it. That single rule is what keeps seven
people's work looking like one product.
