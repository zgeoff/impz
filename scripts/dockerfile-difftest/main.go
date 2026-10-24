package main

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/moby/buildkit/frontend/dockerfile/parser"
)

type instruction struct {
	Keyword string   `json:"keyword"`
	Flags   []string `json:"flags"`
	Words   []string `json:"words"`
	Trigger string   `json:"trigger,omitempty"`
}

type result struct {
	Error        string        `json:"error,omitempty"`
	Escape       string        `json:"escape,omitempty"`
	Instructions []instruction `json:"instructions,omitempty"`
}

func parse(dockerfile string) result {
	parsed, err := parser.Parse(strings.NewReader(dockerfile))
	if err != nil {
		return result{Error: err.Error()}
	}

	out := result{Escape: string(parsed.EscapeToken), Instructions: []instruction{}}

	for _, node := range parsed.AST.Children {
		item := instruction{Keyword: strings.ToLower(node.Value), Flags: node.Flags, Words: []string{}}
		if item.Flags == nil {
			item.Flags = []string{}
		}

		for next := node.Next; next != nil; next = next.Next {
			item.Words = append(item.Words, next.Value)
		}

		if item.Keyword == "onbuild" && node.Next != nil && len(node.Next.Children) > 0 {
			item.Trigger = strings.ToLower(node.Next.Children[0].Value)
		}

		out.Instructions = append(out.Instructions, item)
	}

	return out
}

func main() {
	var dockerfiles []string
	if err := json.NewDecoder(os.Stdin).Decode(&dockerfiles); err != nil {
		panic(err)
	}

	encoder := json.NewEncoder(os.Stdout)

	for _, dockerfile := range dockerfiles {
		if err := encoder.Encode(parse(dockerfile)); err != nil {
			panic(err)
		}
	}
}
