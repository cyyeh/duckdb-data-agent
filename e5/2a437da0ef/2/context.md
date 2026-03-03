# Session Context

## User Prompts

### Prompt 1

fix this issue

Error: API Error: 400 {"error":{"message":"litellm.BadRequestError: OpenAIException - {\n "error": {\n "message": "Invalid schema for function 'mcp__duckdb__render_chart': In context=('properties', 'data'), array schema missing items.",\n "type": "invalid_request_error",\n "param": "tools[19].parameters",\n "code": "invalid_function_parameters"\n }\n}. Received Model Group=gpt-5.2-2025-12-11\nAvailable Model Group Fallbacks=None","type":null,"param":null,"code":"400"}}

Error: Cl...

### Prompt 2

[Request interrupted by user]

### Prompt 3

you should not be in main branch, work in litellm-proxy worktree

### Prompt 4

update readme so make dev works out of the box without starting litellm separately

### Prompt 5

no, you don't need to specify docker compose up litellm -d

Start the LiteLLM proxy (runs as a Docker container):

docker compose up litellm -d
Start both the frontend and backend:

make dev

### Prompt 6

fuck, no, opposite

### Prompt 7

commit this

