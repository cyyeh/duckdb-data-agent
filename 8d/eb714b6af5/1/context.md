# Session Context

## User Prompts

### Prompt 1

Implement the following plan:

# Plan: Add docker-compose.yml and update Makefile/README

## Context

The project currently has individual Dockerfiles for the main app and sidecar, but no docker-compose file to orchestrate them together. Users must manually build images, create Docker networks, and manage container isolation setup. A `docker-compose.yml` will simplify running all services (app + sidecar) with a single command.

## Design

### Architecture

The sidecar is **not a static service**...

### Prompt 2

fix this: WARN[0000] a network with name agent-sandbox exists but was not created by compose.
Set `external: true` to use an existing network

### Prompt 3

commit this and push

