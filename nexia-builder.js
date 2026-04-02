'use strict';
const NexiaBuilder = (() => {
    let _canvasArea = null;
    function initDragAndDrop() {
        const blocks = document.querySelectorAll('.canvas-block');
        _canvasArea = document.querySelector('.canvas-center');
        if (!blocks.length || !_canvasArea) return;
        blocks.forEach(block => {
            block.setAttribute('draggable', 'true');
            block.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', block.innerText);
                block.style.opacity = '0.5';
            });
            block.addEventListener('dragend', () => block.style.opacity = '1');
        });
        const dropZone = document.querySelector('.canvas-area');
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault(); dropZone.style.borderColor = 'var(--cyan)'; dropZone.style.background = 'rgba(0, 229, 255, 0.05)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = 'var(--brd2)'; dropZone.style.background = 'var(--bg3)';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--brd2)'; dropZone.style.background = 'var(--bg3)';
            const blockName = e.dataTransfer.getData('text/plain');
            if(blockName) {
                const instruction = dropZone.querySelector('div[style*="font-size:12px"]');
                if (instruction) instruction.style.display = 'none';
                const newEl = document.createElement('div');
                newEl.style.cssText = 'width:100%; padding:15px; margin-bottom:10px; background:var(--bg2); border:1px solid var(--cyanbrd); border-radius:8px; color:var(--white); font-weight:600; text-align:left; display:flex; justify-content:space-between;';
                newEl.innerHTML = `<span>${blockName}</span> <span style="cursor:pointer; color:var(--red);" onclick="this.parentElement.remove()">🗑️</span>`;
                _canvasArea.appendChild(newEl);
            }
        });
    }
    document.addEventListener('DOMContentLoaded', initDragAndDrop);
    return { init: initDragAndDrop };
})();
window.NexiaBuilder = NexiaBuilder;
