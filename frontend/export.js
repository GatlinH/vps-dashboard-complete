// frontend/export.js - 完整数据导出系统

class DataExporter {
    /**
     * 导出为 CSV
     */
    static exportToCSV(data, filename = 'export.csv', options = {}) {
        const {
            headers = null,
            encoding = 'utf-8',
            delimiter = ',',
        } = options;

        if (!Array.isArray(data) || data.length === 0) {
            console.warn('数据为空，无法导出');
            return;
        }

        // 获取表头
        const cols = headers || Object.keys(data[0]);
        
        // 构建 CSV
        const csv = [
            cols.map(h => this._escapeCsvField(h)).join(delimiter),
            ...data.map(row =>
                cols.map(col => {
                    const val = row[col];
                    return this._escapeCsvField(val);
                }).join(delimiter)
            ),
        ].join('\n');

        this._downloadFile(csv, filename, `text/csv;charset=${encoding}`);
    }

    /**
     * 导出为 JSON
     */
    static exportToJSON(data, filename = 'export.json', options = {}) {
        const {
            pretty = true,
            indent = 2,
        } = options;

        const json = JSON.stringify(
            data,
            null,
            pretty ? indent : undefined
        );

        this._downloadFile(json, filename, 'application/json;charset=utf-8');
    }

    /**
     * 导出为 Excel（需要 XLSX 库）
     */
    static exportToExcel(data, filename = 'export.xlsx', options = {}) {
        if (typeof XLSX === 'undefined') {
            console.error('XLSX 库未加载，请先引入 https://cdn.jsdelivr.net/npm/xlsx@latest/dist/xlsx.full.min.js');
            return;
        }

        const {
            sheetName = 'Sheet1',
            headers = null,
        } = options;

        try {
            // 如果提供了表头映射，使用它
            let exportData = data;
            if (headers && Array.isArray(data)) {
                exportData = data.map(row => {
                    const newRow = {};
                    headers.forEach(h => {
                        newRow[h.label || h] = row[h.key || h];
                    });
                    return newRow;
                });
            }

            const ws = XLSX.utils.json_to_sheet(exportData);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, sheetName);
            XLSX.writeFile(wb, filename);
        } catch (e) {
            console.error('Excel 导出失败:', e);
        }
    }

    /**
     * 导出为 PDF（需要 jsPDF 和 html2canvas）
     */
    static async exportToPDF(element, filename = 'export.pdf', options = {}) {
        if (typeof jsPDF === 'undefined' || typeof html2canvas === 'undefined') {
            console.error('需要 jsPDF 和 html2canvas 库');
            return;
        }

        try {
            const {
                orientation = 'portrait',
                format = 'a4',
                margin = 10,
            } = options;

            const canvas = await html2canvas(element);
            const imgData = canvas.toDataURL('image/png');
            
            const pdf = new jsPDF({
                orientation,
                unit: 'mm',
                format,
            });

            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const imgWidth = pageWidth - (margin * 2);
            const imgHeight = (canvas.height * imgWidth) / canvas.width;

            let heightLeft = imgHeight;
            let position = margin;

            pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
            heightLeft -= (pageHeight - margin * 2);

            while (heightLeft >= 0) {
                position = heightLeft - imgHeight + margin;
                pdf.addPage();
                pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
                heightLeft -= (pageHeight - margin * 2);
            }

            pdf.save(filename);
        } catch (e) {
            console.error('PDF 导出失败:', e);
        }
    }

    /**
     * 导出为 Markdown
     */
    static exportToMarkdown(data, filename = 'export.md', options = {}) {
        const {
            title = 'Export Data',
            description = '',
        } = options;

        let md = '';

        // 添加标题
        if (title) {
            md += `# ${title}\n\n`;
        }

        // 添加描述
        if (description) {
            md += `${description}\n\n`;
        }

        // 添加元数据
        md += `**导出时间:** ${new Date().toLocaleString()}\n\n`;

        // 添加数据
        if (Array.isArray(data) && data.length > 0) {
            const headers = Object.keys(data[0]);
            
            // 表头
            md += `| ${headers.join(' | ')} |\n`;
            md += `| ${headers.map(() => '---').join(' | ')} |\n`;
            
            // 行数据
            data.forEach(row => {
                md += `| ${headers.map(h => this._escapeMdField(row[h])).join(' | ')} |\n`;
            });
        } else if (typeof data === 'object') {
            md += '```json\n';
            md += JSON.stringify(data, null, 2);
            md += '\n```\n';
        }

        this._downloadFile(md, filename, 'text/markdown;charset=utf-8');
    }

    /**
     * 导出为 HTML
     */
    static exportToHTML(data, filename = 'export.html', options = {}) {
        const {
            title = 'Export Data',
            style = '',
        } = options;

        let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this._escapeHtml(title)}</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
        }
        h1 {
            color: #333;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            background-color: white;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 12px;
            text-align: left;
        }
        th {
            background-color: #4CAF50;
            color: white;
        }
        tr:hover {
            background-color: #f5f5f5;
        }
        ${style}
    </style>
</head>
<body>
    <h1>${this._escapeHtml(title)}</h1>
    <p>导出时间: ${new Date().toLocaleString()}</p>
`;

        if (Array.isArray(data) && data.length > 0) {
            const headers = Object.keys(data[0]);
            
            html += '<table>\n';
            html += '<thead><tr>\n';
            headers.forEach(h => {
                html += `<th>${this._escapeHtml(h)}</th>\n`;
            });
            html += '</tr></thead>\n';
            
            html += '<tbody>\n';
            data.forEach(row => {
                html += '<tr>\n';
                headers.forEach(h => {
                    html += `<td>${this._escapeHtml(row[h])}</td>\n`;
                });
                html += '</tr>\n';
            });
            html += '</tbody>\n';
            html += '</table>\n';
        }

        html += `</body>
</html>`;

        this._downloadFile(html, filename, 'text/html;charset=utf-8');
    }

    /**
     * 导出为压缩包（需要 JSZip）
     */
    static async exportToZip(files, filename = 'export.zip') {
        if (typeof JSZip === 'undefined') {
            console.error('JSZip 库未加载');
            return;
        }

        try {
            const zip = new JSZip();
            
            files.forEach(file => {
                zip.file(file.name, file.content);
            });

            const blob = await zip.generateAsync({ type: 'blob' });
            this._downloadFileBlob(blob, filename);
        } catch (e) {
            console.error('ZIP 导出失败:', e);
        }
    }

    /**
     * 批量导出
     */
    static async exportMultiple(data, formats = ['csv', 'json'], baseFilename = 'export') {
        for (const format of formats) {
            const filename = `${baseFilename}.${format}`;
            
            switch (format.toLowerCase()) {
                case 'csv':
                    this.exportToCSV(data, filename);
                    break;
                case 'json':
                    this.exportToJSON(data, filename);
                    break;
                case 'md':
                case 'markdown':
                    this.exportToMarkdown(data, filename);
                    break;
                case 'html':
                    this.exportToHTML(data, filename);
                    break;
                default:
                    console.warn(`不支持的格式: ${format}`);
            }

            // 延迟，避免浏览器限制
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    /**
     * 复制到剪贴板
     */
    static async copyToClipboard(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            } else {
                // 降级方案
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                document.body.removeChild(textarea);
                return true;
            }
        } catch (e) {
            console.error('复制失败:', e);
            return false;
        }
    }

    /**
     * CSV 字段转义
     */
    static _escapeCsvField(field) {
        if (field === null || field === undefined) {
            return '';
        }

        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    /**
     * Markdown 字段转义
     */
    static _escapeMdField(field) {
        if (field === null || field === undefined) {
            return '';
        }
        return String(field).replace(/\|/g, '\\|');
    }

    /**
     * HTML 字段转义
     */
    static _escapeHtml(text) {
        if (text === null || text === undefined) {
            return '';
        }

        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;',
        };

        return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * 下载文件
     */
    static _downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        this._downloadFileBlob(blob, filename);
    }

    /**
     * 下载 Blob
     */
    static _downloadFileBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        // 延迟释放 URL
        setTimeout(() => URL.revokeObjectURL(url), 100);
    }
}

export { DataExporter };
