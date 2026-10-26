"use client";

import * as React from "react";

import { SendIcon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { RepeaterSendResponse } from "@/lib/types";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export type RepeaterInitial = {
  method?: string;
  url?: string;
  headersText?: string;
  body?: string;
};

type HistoryEntry = {
  id: number;
  method: string;
  url: string;
  headersText: string;
  body: string;
  useProxy: boolean;
  insecure: boolean;
  response: RepeaterSendResponse;
};

export function parseHeadersText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!name) continue;
    // The API accepts one value per name. Cookies use semicolon separators;
    // other duplicate headers preserve the common comma-separated semantics.
    const existingName = Object.keys(result).find((item) => item.toLowerCase() === name.toLowerCase());
    if (!existingName) {
      result[name] = value;
    } else {
      const separator = existingName.toLowerCase() === "cookie" ? "; " : ", ";
      result[existingName] = `${result[existingName]}${separator}${value}`;
    }
  }
  return result;
}

export function formatHeaders(headers: Record<string, string[]> | Record<string, string>): string {
  return Object.entries(headers)
    .flatMap(([name, value]) =>
      Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`],
    )
    .join("\n");
}

export function buildRawResponse(response: RepeaterSendResponse): string {
  if (!response.status) return "";
  const statusLine = `${response.proto || "HTTP/1.1"} ${response.status_text || response.status}`.trim();
  const headers = formatHeaders(response.headers);
  return `${statusLine}\n${headers}\n\n${response.body}`;
}

export function headersFromReqHead(reqHead?: string): string {
  if (!reqHead) return "";
  const lines = reqHead.replace(/\r\n?/g, "\n").split("\n");
  // Evidence heads normally start with `METHOD path HTTP/x.y`, but tolerate
  // leading blank lines and CR-only captures from older traffic records.
  let requestLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index].trim();
    if (!candidate) continue;
    if (/^(?:[A-Z]+)\s+\S+\s+HTTP\/\d(?:\.\d)?$/i.test(candidate)) requestLine = index;
    break;
  }
  const start = requestLine >= 0 ? requestLine + 1 : 0;
  return lines.slice(start).join("\n").replace(/\n+$/, "");
}

export function FindingRepeaterDialog({
  open,
  onOpenChange,
  initial,
  findingLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: RepeaterInitial;
  findingLabel?: string;
}) {
  const [method, setMethod] = React.useState("GET");
  const [url, setURL] = React.useState("");
  const [headersText, setHeadersText] = React.useState("");
  const [body, setBody] = React.useState("");
  const [useProxy, setUseProxy] = React.useState(true);
  const [insecure, setInsecure] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [response, setResponse] = React.useState<RepeaterSendResponse | null>(null);
  const [history, setHistory] = React.useState<HistoryEntry[]>([]);
  const sequence = React.useRef(0);
  const generation = React.useRef(0);
  const sending = React.useRef(false);

  React.useEffect(() => {
    sending.current = false;
    setBusy(false);
    if (!open) return;
    const nextMethod = (initial?.method ?? "GET").toUpperCase();
    setMethod(METHODS.includes(nextMethod as (typeof METHODS)[number]) ? nextMethod : "GET");
    setURL(initial?.url ?? "");
    setHeadersText(initial?.headersText ?? "");
    setBody(initial?.body ?? "");
    setUseProxy(true);
    setInsecure(false);
    setResponse(null);
    return () => {
      // Closing, reseeding, or unmounting makes any pending result obsolete.
      generation.current += 1;
      sending.current = false;
    };
  }, [open, initial?.method, initial?.url, initial?.headersText, initial?.body]);

  async function send() {
    // State alone cannot stop a second click before React disables the button.
    if (sending.current || !open) return;
    const target = url.trim();
    if (!target) {
      toast.error("请填写 URL");
      return;
    }
    const requestGeneration = ++generation.current;
    sending.current = true;
    setBusy(true);
    setResponse(null);
    try {
      const result = await api.repeaterSend({
        method,
        url: target,
        headers: parseHeadersText(headersText),
        body,
        use_recording_proxy: useProxy,
        insecure_skip_verify: insecure,
      });
      if (requestGeneration !== generation.current) return;
      setResponse(result);
      const id = ++sequence.current;
      setHistory((previous) =>
        [
          { id, method, url: target, headersText, body, useProxy, insecure, response: result },
          ...previous,
        ].slice(0, 20),
      );
    } catch (error) {
      if (requestGeneration === generation.current) toast.error((error as Error).message);
    } finally {
      if (requestGeneration === generation.current) {
        sending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          // Invalidate immediately, before the parent's close render/effect.
          generation.current += 1;
          sending.current = false;
          setBusy(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="flex max-h-[92vh] w-[min(1150px,96vw)] max-w-none flex-col gap-3 overflow-hidden sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Repeater · 请求重放</DialogTitle>
          <DialogDescription>
            手工编辑并发送 HTTP 请求，便于验证漏洞与撰写报告{findingLabel ? ` · ${findingLabel}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-28">
            <Label className="mb-1 block text-xs text-muted-foreground">方法</Label>
            <Select value={method} onValueChange={setMethod} disabled={busy}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {METHODS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[240px] flex-1">
            <Label className="mb-1 block text-xs text-muted-foreground">URL</Label>
            <Input
              disabled={busy}
              value={url}
              onChange={(event) => setURL(event.target.value)}
              placeholder="https://target.example/path"
              spellCheck={false}
            />
          </div>
          <Button disabled={busy} onClick={() => void send()}>
            <SendIcon data-icon="inline-start" />
            发送
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Label className="flex items-center gap-2" htmlFor="repeater-use-proxy">
            <Checkbox
              id="repeater-use-proxy"
              disabled={busy}
              checked={useProxy}
              onCheckedChange={(value) => setUseProxy(value === true)}
            />
            经流量代理
          </Label>
          <Label className="flex items-center gap-2" htmlFor="repeater-insecure">
            <Checkbox
              id="repeater-insecure"
              disabled={busy}
              checked={insecure}
              onCheckedChange={(value) => setInsecure(value === true)}
            />
            跳过 TLS 校验
          </Label>
          {response ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {response.status ? <Badge variant="secondary">{response.status_text || response.status}</Badge> : null}
              <span>{response.elapsed_ms} ms</span>
              <span>{response.body_bytes.toLocaleString()} 字节</span>
              {response.body_truncated ? <Badge variant="outline">正文已截断</Badge> : null}
            </div>
          ) : null}
        </div>
        <div className="grid min-h-0 flex-1 gap-3 overflow-hidden lg:grid-cols-[180px_1fr_1fr]">
          <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-md border p-2">
            <div className="text-xs font-medium text-muted-foreground">会话历史</div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">发送后会出现在这里</p>
              ) : (
                history.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={busy}
                    className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted"
                    onClick={() => {
                      setMethod(entry.method);
                      setURL(entry.url);
                      setHeadersText(entry.headersText);
                      setBody(entry.body);
                      setUseProxy(entry.useProxy);
                      setInsecure(entry.insecure);
                      setResponse(entry.response);
                    }}
                  >
                    <div className="truncate font-mono text-xs">
                      {entry.method} {entry.response.status || "ERR"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{entry.url}</div>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
            <div className="text-xs font-medium">请求</div>
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex min-h-0 flex-1 flex-col gap-1">
                <Label className="text-xs text-muted-foreground">请求头</Label>
                <Textarea
                  className="min-h-[120px] flex-1 font-mono text-xs"
                  disabled={busy}
                  value={headersText}
                  onChange={(event) => setHeadersText(event.target.value)}
                  placeholder="Header: value"
                  spellCheck={false}
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1">
                <Label className="text-xs text-muted-foreground">请求体</Label>
                <Textarea
                  className="min-h-[120px] flex-1 font-mono text-xs"
                  disabled={busy}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="请求正文（可选）"
                  spellCheck={false}
                />
              </div>
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
            <div className="text-xs font-medium">响应</div>
            {response?.error ? (
              <Alert variant={response.status ? "default" : "destructive"}>
                <AlertDescription className="break-all font-mono text-xs">{response.error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              {response ? (
                <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs">
                  {buildRawResponse(response)}
                </pre>
              ) : (
                <p className="p-3 text-xs text-muted-foreground">发送后显示原始响应</p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
