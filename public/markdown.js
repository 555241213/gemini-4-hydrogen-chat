/**
 * 零外部依赖的安全 Markdown 渲染器（含代码块语言栏与一键复制支持）。
 * 先对全部输入进行 HTML 转义，杜绝 XSS，再安全映射受支持的 Markdown 结构。
 */
(function (global) {
  "use strict";

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sanitizeUrl(url) {
    const trimmed = String(url || "").trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return escapeHtml(trimmed);
    }
    return "#";
  }

  function renderInline(rawText) {
    const inlineCodes = [];
    let text = String(rawText).replace(/`([^`]+)`/g, function (_, code) {
      const idx = inlineCodes.length;
      inlineCodes.push('<code class="inline-code">' + escapeHtml(code) + "</code>");
      return "\u0000IC" + idx + "\u0000";
    });

    text = escapeHtml(text);

    // 链接 [text](https://...) 先提取占位，避免后续符号规则破坏标签或 URL
    const linkTokens = [];
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, url) {
      const safeHref = sanitizeUrl(url);
      const idx = linkTokens.length;
      linkTokens.push(
        '<a href="' + safeHref + '" target="_blank" rel="noopener noreferrer">' + label + "</a>",
      );
      return "\u0000LK" + idx + "\u0000";
    });

    // 粗体 / 删除线 / 动作描写（*动作* 与 （动作） 渲染为淡灰色斜体）
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em class="action-text">$2</em>');
    text = text.replace(/（([^（）\n]+)）/g, '<em class="action-text">（$1）</em>');

    // 还原链接与行内代码
    text = text.replace(/\u0000LK(\d+)\u0000/g, function (_, idx) {
      return linkTokens[Number(idx)] || "";
    });
    text = text.replace(/\u0000IC(\d+)\u0000/g, function (_, idx) {
      return inlineCodes[Number(idx)] || "";
    });

    return text;
  }

  function encodeBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function buildCodeBlockHtml(lang, rawCode) {
    const cleanLang = (lang || "CODE").trim().toUpperCase() || "CODE";
    const b64 = encodeBase64Utf8(rawCode);
    return (
      '<div class="glass-code-card">' +
      '<div class="glass-code-header">' +
      '<span class="glass-code-lang">' + escapeHtml(cleanLang) + "</span>" +
      '<button type="button" class="glass-code-copy-btn" data-code-b64="' + b64 + '">复制</button>' +
      "</div>" +
      "<pre><code>" + escapeHtml(rawCode) + "</code></pre>" +
      "</div>"
    );
  }

  function parseTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map(function (c) { return c.trim(); });
  }

  function isTableSeparator(line) {
    return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim());
  }

  function renderBlocks(text) {
    const lines = text.split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*$/.test(line)) {
        i += 1;
        continue;
      }

      if (/^\u0000CB\d+\u0000$/.test(line.trim())) {
        out.push(line.trim());
        i += 1;
        continue;
      }

      // 分割线
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        out.push("<hr />");
        i += 1;
        continue;
      }

      // 标题 # ~ ####
      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        out.push("<h" + level + ">" + renderInline(headingMatch[2]) + "</h" + level + ">");
        i += 1;
        continue;
      }

      // 引用块
      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push("<blockquote>" + renderBlocks(quoteLines.join("\n")) + "</blockquote>");
        continue;
      }

      // 表格
      if (
        line.includes("|") &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      ) {
        const headers = parseTableRow(line);
        i += 2;
        const bodyRows = [];
        while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
          bodyRows.push(parseTableRow(lines[i]));
          i += 1;
        }
        let tableHtml = "<table><thead><tr>";
        headers.forEach(function (h) {
          tableHtml += "<th>" + renderInline(h) + "</th>";
        });
        tableHtml += "</tr></thead><tbody>";
        bodyRows.forEach(function (row) {
          tableHtml += "<tr>";
          for (let c = 0; c < headers.length; c += 1) {
            tableHtml += "<td>" + renderInline(row[c] || "") + "</td>";
          }
          tableHtml += "</tr>";
        });
        tableHtml += "</tbody></table>";
        out.push(tableHtml);
        continue;
      }

      // 无序列表
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push("<li>" + renderInline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>");
          i += 1;
        }
        out.push("<ul>" + items.join("") + "</ul>");
        continue;
      }

      // 有序列表
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push("<li>" + renderInline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
          i += 1;
        }
        out.push("<ol>" + items.join("") + "</ol>");
        continue;
      }

      // 普通段落
      const paraLines = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\u0000CB\d+\u0000$/.test(lines[i].trim()) &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^\s*([-*_])\1{2,}\s*$/.test(lines[i]) &&
        !(lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        paraLines.push(lines[i]);
        i += 1;
      }
      out.push("<p>" + paraLines.map(renderInline).join("<br />") + "</p>");
    }

    return out.join("");
  }

  function renderMarkdown(markdownText) {
    const source = String(markdownText || "").replace(/\r\n?/g, "\n");
    const codeBlocks = [];

    // 先抽取完整围栏代码块（```lang ... ```）
    let placeholderText = source.replace(/```([a-zA-Z0-9_+#-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      const idx = codeBlocks.length;
      codeBlocks.push(buildCodeBlockHtml(lang, code.replace(/\n$/, "")));
      return "\n\u0000CB" + idx + "\u0000\n";
    });

    // 若处于流式输出中且遇到未闭合的代码块，也按代码卡片实时渲染
    placeholderText = placeholderText.replace(/```([a-zA-Z0-9_+#-]*)\n([\s\S]*)$/g, function (_, lang, code) {
      const idx = codeBlocks.length;
      codeBlocks.push(buildCodeBlockHtml(lang, code));
      return "\n\u0000CB" + idx + "\u0000\n";
    });

    let html = renderBlocks(placeholderText);
    html = html.replace(/<p>\u0000CB(\d+)\u0000<\/p>/g, function (_, idx) {
      return codeBlocks[Number(idx)] || "";
    });
    html = html.replace(/\u0000CB(\d+)\u0000/g, function (_, idx) {
      return codeBlocks[Number(idx)] || "";
    });

    return html;
  }

  global.XingmangMarkdown = {
    render: renderMarkdown,
  };
})(window);
