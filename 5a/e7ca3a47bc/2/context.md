# Session Context

## User Prompts

### Prompt 1

Why Claude models work but OpenAI models don't                                                                                                                          

  The Claude Agent SDK's conversation loop ends when the model produces a text-only response (no tool_use blocks). This is by design — text-only means "I'm done."        

  Claude models naturally support mixing text blocks and tool_use blocks in a single response. When the old prompt said "write narrative text, then start th...

### Prompt 2

please carefully examine how could bifrost handle it?

