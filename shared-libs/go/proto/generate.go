// Package proto holds auto-generated Protobuf message types for UBR NMS (WO-024).
//
// DO NOT EDIT — this package is regenerated via `go generate ./...`
// Run from the repo root:
//
//	cd shared-libs/go && go generate ./...
//
// Prerequisites:
//
//	go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
//	brew install bufbuild/buf/buf   # or download buf from https://buf.build/docs/installation
//
// The `buf generate` command (configured in proto/buf.gen.yaml) writes
// *_pb.go files into this directory. The hand-written models in ../models/
// remain as the public API; they are now validated against proto schemas
// in adapter_test.go.

package proto

//go:generate buf generate ../../proto --output . --template ../../proto/buf.gen.yaml
