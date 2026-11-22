import {
  siNginx, siCaddy, siApache, siTraefikproxy, siHaproxy, siMysql, siMariadb, siPostgresql, siMongodb, siRedis,
  siElasticsearch, siRabbitmq, siApachekafka, siMinio, siPortainer, siGrafana, siPrometheus, siUptimekuma, siNetdata,
  siAlist, siNextcloud, siGitea, siJenkins, siJupyter, siN8n, siWireguard, siDocker, siQbittorrent, siNodedotjs,
  siPython, siOpenjdk, siPhp, siApachetomcat, siEclipsemosquitto, siClickhouse, siInfluxdb, siVaultwarden,
  siWordpress, siGunicorn, siFastapi, si1panel, siGitlab, siGhost, siSyncthing, siJellyfin, siPlex, siEmby,
  siHomeassistant, siAdguard, siPihole, siOpenvpn, siTailscale, siZerotier, siCoolify, siUmami, siMetabase,
  siKibana, siConsul, siVault, siImmich, siCloudflare, siSupabase, siMatomo, siGo, siRust, siDeno, siBun,
  siDebian, siUbuntu, siLinux
} from 'simple-icons'

export interface IconDef {
  path?: string
  color: string
  /** text glyph when no brand icon is available */
  text?: string
}

type SI = { path: string; hex: string }
const b = (i: SI, color?: string): IconDef => ({ path: i.path, color: color || '#' + i.hex })
const t = (text: string, color: string): IconDef => ({ text, color })

const MAP: Record<string, IconDef> = {
  nginx: b(siNginx), caddy: b(siCaddy), apache: b(siApache, '#D22128'), httpd: b(siApache, '#D22128'),
  traefik: b(siTraefikproxy), haproxy: b(siHaproxy, '#3f8fd2'), mysql: b(siMysql, '#4479A1'), mariadb: b(siMariadb, '#C0765A'),
  postgres: b(siPostgresql), postgresql: b(siPostgresql), mongodb: b(siMongodb), mongo: b(siMongodb), redis: b(siRedis),
  elasticsearch: b(siElasticsearch), rabbitmq: b(siRabbitmq), kafka: b(siApachekafka, '#e0e0e0'), minio: b(siMinio),
  portainer: b(siPortainer), grafana: b(siGrafana), prometheus: b(siPrometheus), nodeexporter: b(siPrometheus),
  uptimekuma: b(siUptimekuma), netdata: b(siNetdata), alist: b(siAlist), nextcloud: b(siNextcloud), gitea: b(siGitea),
  jenkins: b(siJenkins, '#D24939'), jupyter: b(siJupyter), n8n: b(siN8n), wireguard: b(siWireguard), docker: b(siDocker),
  registry: b(siDocker), dockerregistry: b(siDocker), qbittorrent: b(siQbittorrent), nodejs: b(siNodedotjs), node: b(siNodedotjs),
  python: b(siPython, '#4B8BBE'), gunicorn: b(siGunicorn), uvicorn: b(siFastapi), fastapi: b(siFastapi), java: b(siOpenjdk, '#E76F00'),
  php: b(siPhp), phpfpm: b(siPhp), tomcat: b(siApachetomcat), mosquitto: b(siEclipsemosquitto, '#7c6cd8'),
  clickhouse: b(siClickhouse), influxdb: b(siInfluxdb), vaultwarden: b(siVaultwarden, '#3b82f6'), wordpress: b(siWordpress, '#3d9fd6'),
  '1panel': b(si1panel), onepanel: b(si1panel), gitlab: b(siGitlab), ghost: b(siGhost, '#e5e7eb'), syncthing: b(siSyncthing),
  jellyfin: b(siJellyfin), plex: b(siPlex), emby: b(siEmby), homeassistant: b(siHomeassistant), adguard: b(siAdguard),
  adguardhome: b(siAdguard), pihole: b(siPihole), openvpn: b(siOpenvpn), tailscale: b(siTailscale, '#e5e7eb'),
  zerotier: b(siZerotier), coolify: b(siCoolify), umami: b(siUmami, '#e5e7eb'), metabase: b(siMetabase), kibana: b(siKibana),
  consul: b(siConsul), vault: b(siVault, '#FFEC6E'), immich: b(siImmich), cloudflared: b(siCloudflare), supabase: b(siSupabase),
  matomo: b(siMatomo), go: b(siGo), rust: b(siRust, '#e5e7eb'), deno: b(siDeno, '#e5e7eb'), bun: b(siBun, '#fbf0df'),
  debian: b(siDebian), ubuntu: b(siUbuntu), linux: b(siLinux, '#FCC624'),
  // no brand icons available → styled glyphs
  bt: t('宝', '#20a53a'), btpanel: t('宝', '#20a53a'), baota: t('宝', '#20a53a'),
  xui: t('X', '#6366f1'), '3xui': t('3X', '#6366f1'), v2ray: t('V2', '#7c3aed'), xray: t('Xr', '#7c3aed'), v2rayxray: t('Xr', '#7c3aed'),
  singbox: t('SB', '#0ea5e9'), frp: t('frp', '#0ea5e9'), frps: t('frp', '#0ea5e9'), nps: t('nps', '#0ea5e9'),
  memcached: t('Mc', '#22c55e'), codeserver: t('</>', '#3b82f6'), filebrowser: t('FB', '#40c4ff'), aria2: t('A2', '#f59e0b'),
  halo: t('H', '#3b82f6'), sshd: t('>_', '#94a3b8')
}

const CATEGORY: Record<string, IconDef> = {
  panel: t('▦', '#22c55e'),
  web: t('◎', '#3b82f6'),
  database: t('DB', '#f59e0b'),
  cache: t('⚡', '#ef4444'),
  proxy: t('⇄', '#06b6d4'),
  monitoring: t('📈', '#a855f7'),
  'proxy-tool': t('⛨', '#6366f1'),
  storage: t('🗄', '#14b8a6'),
  system: t('⚙', '#94a3b8'),
  app: t('◆', '#64748b')
}

export function iconFor(kind: string, category: string, name = ''): IconDef {
  const k = (kind || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (MAP[k]) return MAP[k]
  const n = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (MAP[n]) return MAP[n]
  for (const key of Object.keys(MAP)) if (key.length > 3 && (k.includes(key) || n.includes(key))) return MAP[key]
  const base = CATEGORY[category] || CATEGORY.app
  const letter = (name || kind || '?').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 2)
  return { color: base.color, text: letter ? letter[0].toUpperCase() + (letter[1] || '').toLowerCase() : base.text }
}

export function osIcon(os: string | undefined): IconDef {
  const o = (os || '').toLowerCase()
  if (o.includes('ubuntu')) return MAP.ubuntu
  if (o.includes('debian')) return MAP.debian
  return MAP.linux
}
