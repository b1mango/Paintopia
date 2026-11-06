import { describe, expect, it, vi } from "vitest";
import { callImageProvider, callImageProviderStream } from "../src/providers/imageProvider";
import { callTextProvider } from "../src/providers/textProvider";

describe("image provider adapter", () => {
  it("calls OpenAI-compatible image generation endpoints", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "abc123" }]
    }), { status: 200 }));

    const result = await callImageProvider({
      id: "p1",
      name: "Images",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: { size: "1024x1024", quality: "high" }
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/v1/images/generations", expect.objectContaining({
      method: "POST"
    }));
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const requestInit = calls[0]![1];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: "gpt-image-2",
      prompt: "misty valley",
      size: "1024x1024"
    });
    expect(result.images[0]?.b64Json).toBe("abc123");
  });

  it("forwards gpt-image-2 resolution tiers without synthesizing concrete size", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      quality: "4K",
      size: "1536x1024",
      data: [{ b64_json: "tiered-image" }]
    }), { status: 200 }));

    const result = await callImageProvider({
      id: "p-tier",
      name: "Tiered Images",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: { resolution: "4K", quality: "high" }
    }, fetchImpl);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]![1].body));
    expect(body).toMatchObject({
      model: "gpt-image-2",
      prompt: "misty valley",
      quality: "high",
      resolution: "4K"
    });
    expect(body).not.toHaveProperty("size");
    expect(result.images[0]).toMatchObject({
      b64Json: "tiered-image",
      upstreamQuality: "4K",
      upstreamSize: "1536x1024"
    });
  });

  it("streams partial and completed images from OpenAI-compatible image endpoints", async () => {
    const sse = [
      'data: {"type":"image_generation.partial_image","b64_json":"preview123","output_format":"jpeg","partial_image_index":0}',
      "",
      'data: {"type":"image_generation.completed","b64_json":"final123","output_format":"png"}',
      "",
      "data: [DONE]",
      ""
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }));
    const onPartial = vi.fn();

    const result = await callImageProviderStream({
      id: "p-stream",
      name: "Streaming Images",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: { quality: "low" }
    }, onPartial, fetchImpl);

    expect(onPartial).toHaveBeenCalledWith({
      b64Json: "preview123",
      partialImageIndex: 0,
      mimeType: "image/jpeg"
    });
    expect(result.images).toEqual([{ b64Json: "final123" }]);
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]![1].body));
    expect(body).toMatchObject({
      stream: true,
      partial_images: 1,
      quality: "low",
      n: 1
    });
    expect(body).not.toHaveProperty("size");
    expect(calls[0]![1].headers).toMatchObject({
      Accept: "text/event-stream"
    });
  });

  it("keeps legacy images mode routed to OpenAI-compatible image generation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ url: "https://example.com/out.png" }]
    }), { status: 200 }));

    await callImageProvider({
      id: "p1",
      name: "Images",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "images",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: {}
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/v1/images/generations", expect.objectContaining({
      method: "POST"
    }));
  });

  it("fails image edits mode until an input image is provided", async () => {
    await expect(callImageProvider({
      id: "p-edit",
      name: "Edits",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "edits",
      maxConcurrency: 1
    }, {
      prompt: "add sunset light",
      params: {}
    })).rejects.toThrow("图像编辑需要上传至少一张参考图");
  });

  it("calls OpenAI-compatible image edit endpoints with reference images", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "edited123" }]
    }), { status: 200 }));
    const inputImage = new Blob([Buffer.from("reference-one")], { type: "image/png" });
    const secondImage = new Blob([Buffer.from("reference-two")], { type: "image/jpeg" });

    const result = await callImageProvider({
      id: "p-edit",
      name: "Edits",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "edits",
      maxConcurrency: 1
    }, {
      prompt: "keep the face and change the background",
      params: {
        images: [inputImage, secondImage],
        size: "1024x1536",
        quality: "medium",
        n: 1
      }
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/v1/images/edits", expect.objectContaining({
      method: "POST"
    }));
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const form = calls[0]![1].body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("keep the face and change the background");
    expect(form.get("size")).toBe("1024x1536");
    expect(form.get("quality")).toBe("medium");
    expect(form.get("n")).toBe("1");
    expect(form.getAll("image[]")).toHaveLength(2);
    expect(result.images[0]?.b64Json).toBe("edited123");
  });

  it("calls Responses image_generation tool endpoints", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      output: [
        {
          content: [
            {
              type: "image_generation_call",
              result: "xyz789"
            }
          ]
        }
      ]
    }), { status: 200 }));

    const result = await callImageProvider({
      id: "p2",
      name: "Responses",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-5.5",
      mode: "responses",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: { size: "1024x1024", quality: "high" }
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/v1/responses", expect.objectContaining({
      method: "POST"
    }));
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const requestInit = calls[0]![1];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      model: "gpt-5.5",
      input: "misty valley",
      tools: [{ type: "image_generation", size: "1024x1024", quality: "high" }]
    });
    expect(result.images[0]?.b64Json).toBe("xyz789");
  });

  it("sends reference images to Responses image edits", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: "image_generation_call", result: "responses-edited" }]
    }), { status: 200 }));
    const inputImage = new Blob([Buffer.from("responses-reference")], { type: "image/png" });

    const result = await callImageProvider({
      id: "p-responses-edit",
      name: "Responses edit",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "responses",
      maxConcurrency: 1
    }, {
      prompt: "change the background",
      params: { images: [inputImage], size: "2048x2048", quality: "high" }
    }, fetchImpl);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]![1].body));
    expect(body).toMatchObject({
      model: "gpt-image-2",
      tools: [{ type: "image_generation", action: "edit", size: "2048x2048", quality: "high" }]
    });
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "change the background" },
      {
        type: "input_image",
        image_url: `data:image/png;base64,${Buffer.from("responses-reference").toString("base64")}`,
        detail: "auto"
      }
    ]);
    expect(result.images).toEqual([{ b64Json: "responses-edited" }]);
  });

  it("drops input images echoed by an edit provider", async () => {
    const referenceBytes = Buffer.from("echoed-reference");
    const referenceBase64 = referenceBytes.toString("base64");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      output: [
        { type: "image_generation_call", result: referenceBase64 },
        { type: "image_generation_call", result: "new-generated-image" }
      ]
    }), { status: 200 }));

    const result = await callImageProvider({
      id: "p-responses-echo",
      name: "Responses echo",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "responses",
      maxConcurrency: 1
    }, {
      prompt: "change the background",
      params: {
        images: [new Blob([referenceBytes], { type: "image/png" })],
        quality: "high"
      }
    }, fetchImpl);

    expect(result.images).toEqual([{ b64Json: "new-generated-image" }]);
  });

  it("calls Chat Completions and extracts Markdown data URL images", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        choices: [
          {
            message: {
              content: "![image](data:image/png;base64,chat-image-123)"
            }
          }
        ]
      }
    }), { status: 200 }));

    const result = await callImageProvider({
      id: "p-chat-image",
      name: "Chat image",
      baseUrl: "https://example.com",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "chat_completions",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: { size: "1024x1024", quality: "high" }
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/v1/chat/completions", expect.objectContaining({
      method: "POST"
    }));
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      model: "gpt-image-2",
      messages: [{ role: "user", content: "misty valley" }],
      size: "1024x1024",
      quality: "high",
      n: 1,
      stream: false
    });
    expect(result.images).toEqual([{ b64Json: "chat-image-123" }]);
  });

  it("keeps reference images and forwards explicit Chat image parameters", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "![image](data:image/png;base64,chat-edited)" } }]
    }), { status: 200 }));
    const inputImage = new Blob([Buffer.from("chat-reference")], { type: "image/jpeg" });

    const result = await callImageProvider({
      id: "p-chat-edit",
      name: "Chat edit",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "chat_completions",
      maxConcurrency: 1
    }, {
      prompt: "preserve the subject",
      params: { images: [inputImage], size: "3840x2160", quality: "high", resolution: "4K" }
    }, fetchImpl);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(String(calls[0]![1].body));
    expect(body).toMatchObject({
      model: "gpt-image-2",
      n: 1,
      stream: false
    });
    expect(body).toMatchObject({ size: "3840x2160", quality: "high", resolution: "4K" });
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "preserve the subject" },
      {
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${Buffer.from("chat-reference").toString("base64")}`,
          detail: "auto"
        }
      }
    ]);
    expect(result.images).toEqual([{ b64Json: "chat-edited" }]);
  });

  it("polls Chat Completions image tasks when the gateway responds asynchronously", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        task_id: "task-chat-123",
        status: "queued"
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: "completed",
        data: {
          choices: [
            {
              message: {
                content: "![image](data:image/png;base64,polled-chat-image)"
              }
            }
          ]
        }
      }), { status: 200 }));

    const result = await callImageProvider({
      id: "p-chat-task",
      name: "Chat task image",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "chat_completions",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: {}
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://example.com/v1/chat/completions", expect.objectContaining({
      method: "POST"
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://example.com/v1/images/generations/task-chat-123", expect.objectContaining({
      method: "GET"
    }));
    expect(result.images).toEqual([{ b64Json: "polled-chat-image" }]);
  });

  it("adds /v1 for image gateways when base URL is the host root", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: "abc123" }]
    }), { status: 200 }));

    await callImageProvider({
      id: "p-root",
      name: "Root Gateway",
      baseUrl: "https://image-gateway.example.com",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: {}
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://image-gateway.example.com/v1/images/generations", expect.objectContaining({
      method: "POST"
    }));
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      model: "gpt-image-2",
      prompt: "misty valley",
      quality: "high",
      n: 1
    });
  });

  it("explains Codex ChatGPT-account gpt-image-2 limitations", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      detail: "The 'gpt-image-2' model is not supported when using Codex with a ChatGPT account."
    }), { status: 400 }));

    await expect(callImageProvider({
      id: "p-codex",
      name: "Codex",
      baseUrl: "http://localhost:55639/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "responses",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: {}
    }, fetchImpl)).rejects.toThrow("Responses 工具模式");
  });

  it("turns Cloudflare 524 HTML into a compact timeout error", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "<html><head><title>newapi.example | 524: A timeout occurred</title></head><body><span class=\"code-label\">Error code 524</span><p>The origin web server timed out responding to this request.</p></body></html>",
      { status: 524, headers: { "Content-Type": "text/html" } }
    ));

    await expect(callImageProvider({
      id: "p-timeout",
      name: "NewAPI",
      baseUrl: "https://newapi.example",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: {}
    }, fetchImpl)).rejects.toThrow("Cloudflare 524");
    await expect(callImageProvider({
      id: "p-timeout",
      name: "NewAPI",
      baseUrl: "https://newapi.example",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: {}
    }, fetchImpl)).rejects.not.toThrow("<html>");
  });

  it("retries transient stream failures once for image generations", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("stream error: stream ID 1; INTERNAL_ERROR; received from peer"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: "retry-ok" }]
      }), { status: 200 }));

    const result = await callImageProvider({
      id: "p-retry",
      name: "Retry Provider",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "gpt-image-2",
      mode: "generations",
      maxConcurrency: 1
    }, {
      prompt: "misty valley",
      params: {}
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.images[0]?.b64Json).toBe("retry-ok");
  });
});

describe("text provider adapter", () => {
  it("calls OpenAI-compatible chat completions endpoints", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "translated prompt"
          }
        }
      ]
    }), { status: 200 }));

    const result = await callTextProvider({
      id: "t1",
      name: "Chat",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "cheap-chat",
      mode: "chat_completions"
    }, {
      systemPrompt: "translate faithfully",
      userPrompt: "雾中山谷"
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/v1/chat/completions", expect.objectContaining({
      method: "POST"
    }));
    expect(result.text).toBe("translated prompt");
  });

  it("adds /v1 for OpenAI-compatible chat gateways when base URL is the host root", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "translated prompt"
          }
        }
      ]
    }), { status: 200 }));

    await callTextProvider({
      id: "t-root",
      name: "Root Gateway",
      baseUrl: "https://new-api.example.com",
      apiKey: "key",
      model: "Translation",
      mode: "chat_completions"
    }, {
      systemPrompt: "translate faithfully",
      userPrompt: "雾中的山谷"
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://new-api.example.com/v1/chat/completions", expect.objectContaining({
      method: "POST"
    }));
  });

  it("uses x-api-key for LinuxDo chat completions gateway with full endpoint URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "translated prompt"
          }
        }
      ]
    }), { status: 200 }));

    await callTextProvider({
      id: "t-linuxdo",
      name: "LinuxDo",
      baseUrl: "https://api.xn-vrvr26c72pz7b.cyou/v1/chat/completions",
      apiKey: "test-key",
      model: "gpt-4o-mini",
      mode: "chat_completions"
    }, {
      systemPrompt: "translate faithfully",
      userPrompt: "雾中山谷"
    }, fetchImpl);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("https://api.xn-vrvr26c72pz7b.cyou/v1/chat/completions");
    expect(calls[0]![1].headers).toMatchObject({
      "x-api-key": "test-key",
      "Content-Type": "application/json"
    });
    expect(calls[0]![1].headers).not.toHaveProperty("api-key");
    expect(calls[0]![1].headers).not.toHaveProperty("Authorization");
  });

  it("calls OpenAI-compatible responses text endpoints", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      output_text: "optimized prompt"
    }), { status: 200 }));

    const result = await callTextProvider({
      id: "t2",
      name: "Responses",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "cheap-responses",
      mode: "responses"
    }, {
      systemPrompt: "optimize",
      userPrompt: "misty valley"
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/v1/responses", expect.objectContaining({
      method: "POST"
    }));
    expect(result.text).toBe("optimized prompt");
  });

  it("extracts only assistant output text from responses payloads", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      output: [
        {
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "1, 2, 3, 4, 5" }
          ]
        },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "translated image prompt" }
          ]
        }
      ]
    }), { status: 200 }));

    const result = await callTextProvider({
      id: "t-responses-output",
      name: "Responses",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      model: "cheap-responses",
      mode: "responses"
    }, {
      systemPrompt: "translate",
      userPrompt: "雾中山谷"
    }, fetchImpl);

    expect(result.text).toBe("translated image prompt");
  });

  it("calls Anthropic messages endpoints with Anthropic headers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "anthropic prompt" }],
      usage: { input_tokens: 5, output_tokens: 7 }
    }), { status: 200 }));

    const result = await callTextProvider({
      id: "t3",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "anthropic-key",
      model: "claude-3-5-sonnet-latest",
      mode: "anthropic_messages"
    }, {
      systemPrompt: "optimize",
      userPrompt: "misty valley"
    }, fetchImpl);

    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]![1]).toMatchObject({ method: "POST" });
    expect(calls[0]![1].headers).toMatchObject({
      "x-api-key": "anthropic-key",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    });
    expect(result.text).toBe("anthropic prompt");
    expect(result.usage.totalTokens).toBe(12);
  });
});
