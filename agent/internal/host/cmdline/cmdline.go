package cmdline

import (
	"os"
	"strings"
)

type Params struct {
	Hostname      string
	IP            string
	GW            string
	IP6           string
	GW6           string
	DNS           []string
	ResetIdentity bool
	Template      bool
	HotplugMemory bool
	Raw           map[string]string
}

func Read() (Params, error) {
	b, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return Params{}, err
	}
	return Parse(string(b)), nil
}

func Parse(line string) Params {
	p := Params{Raw: make(map[string]string)}
	for _, field := range split(line) {
		key, val, _ := strings.Cut(field, "=")
		if key == "memhp_default_state" {
			p.HotplugMemory = true
		}
		name, ok := strings.CutPrefix(key, "imp.")
		if !ok {
			continue
		}
		val = strings.Trim(val, `"`)
		p.Raw[name] = val
		switch name {
		case "hostname":
			p.Hostname = val
		case "ip":
			p.IP = val
		case "gw":
			p.GW = val
		case "reset_identity":
			p.ResetIdentity = val == "1"
		case "ip6":
			p.IP6 = val
		case "gw6":
			p.GW6 = val
		case "template":
			p.Template = val == "1"
		case "dns":
			for _, s := range strings.Split(val, ",") {
				if s = strings.TrimSpace(s); s != "" {
					p.DNS = append(p.DNS, s)
				}
			}
		}
	}
	return p
}

// The kernel allows a double-quoted value with spaces: imp.x="a b".
func split(line string) []string {
	var out []string
	var cur strings.Builder
	quoted := false
	for _, r := range line {
		switch {
		case r == '"':
			quoted = !quoted
			cur.WriteRune(r)
		case !quoted && (r == ' ' || r == '\t' || r == '\n'):
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}
