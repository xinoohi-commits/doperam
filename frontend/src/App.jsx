import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Bot, Play, Square, Loader2, QrCode, MessageSquare, AlertCircle, Clock, CheckCircle2, LogOut, Paperclip, X } from 'lucide-react';
import axios from 'axios';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';
const socket = io(BACKEND_URL);
const API_URL = `${BACKEND_URL}/api`;

function App() {
  const [state, setState] = useState({
    clientStatus: 'DISCONNECTED',
    qr: null,
    isBotRunning: false,
    autoMessageTargetGroup: '',
    autoMessageText: '',
    minIntervalActive: 1,
    maxIntervalActive: 2
  });

  const [groups, setGroups] = useState([]);
  const [logs, setLogs] = useState([]);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [error, setError] = useState('');

  // Form State
  const [sendMode, setSendMode] = useState('group');
  const [targetNumbers, setTargetNumbers] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [message, setMessage] = useState('');
  const [fileData, setFileData] = useState(null);
  const [fileName, setFileName] = useState('');
  const [minDelay, setMinDelay] = useState(1);
  const [maxDelay, setMaxDelay] = useState(2);

  const logsEndRef = useRef(null);

  useEffect(() => {
    socket.on('state-update', (newState) => {
      setState(newState);
      if (newState.isBotRunning) {
        setSendMode(newState.autoMessageSendMode || 'group');
        setSelectedGroup(newState.autoMessageTargetGroup || '');
        setTargetNumbers(newState.autoMessageTargetNumbers || '');
        setMessage(newState.autoMessageText);
        setMinDelay(newState.minIntervalActive);
        setMaxDelay(newState.maxIntervalActive);
      }
    });

    socket.on('log', (logMessage) => {
      setLogs(prev => [...prev, { id: Date.now() + Math.random(), text: logMessage }]);
    });

    return () => {
      socket.off('state-update');
      socket.off('log');
    };
  }, []);

  useEffect(() => {
    if (state.clientStatus === 'CONNECTED') {
      fetchGroups();
    }
  }, [state.clientStatus]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const fetchGroups = async () => {
    setIsLoadingGroups(true);
    try {
      console.log('Fetching groups from:', `${API_URL}/groups`);
      const { data } = await axios.get(`${API_URL}/groups`);
      console.log('Groups fetched:', data);
      setGroups(data.groups);
      if (data.groups.length > 0 && !selectedGroup) {
        setSelectedGroup(data.groups[0].name);
      }
    } catch (err) {
      setError(`Failed to load groups: ${err.message}. Check browser console.`);
      console.error('Axios Fetch Error:', err);
      if (err.response) {
        console.error('Data:', err.response.data);
        console.error('Status:', err.response.status);
      }
    } finally {
      setIsLoadingGroups(false);
    }
  };

  const handleFileChange = (e) => {
    const selected = e.target.files[0];
    if (selected) {
      if (selected.size > 15 * 1024 * 1024) { // 15MB limit
        setError('File is too large. Limit is 15MB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result.split(',')[1];
        setFileData({
          mimetype: selected.type,
          data: base64String,
          filename: selected.name
        });
        setFileName(selected.name);
      };
      reader.readAsDataURL(selected);
    }
  };

  const clearFile = () => {
    setFileData(null);
    setFileName('');
    const fileInput = document.getElementById('file-upload');
    if (fileInput) fileInput.value = '';
  };

  const handleStart = async (e) => {
    e.preventDefault();
    setError('');
    
    if (sendMode === 'group' && !selectedGroup) {
      setError('Please select a group.');
      return;
    }
    if (sendMode === 'numbers' && (!targetNumbers || targetNumbers.trim() === '')) {
      setError('Please enter at least one target number.');
      return;
    }
    if (!message && !fileData) {
      setError('Please enter a message or attach a file.');
      return;
    }
    if (minDelay >= maxDelay) {
      setError('Max delay must be greater than Min delay.');
      return;
    }

    try {
      await axios.post(`${API_URL}/start`, {
        sendMode,
        groupName: sendMode === 'group' ? selectedGroup : '',
        targetNumbers: sendMode === 'numbers' ? targetNumbers : '',
        message,
        minMinutes: Number(minDelay),
        maxMinutes: Number(maxDelay),
        media: fileData
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start bot');
    }
  };

  const handleStop = async () => {
    try {
      await axios.post(`${API_URL}/stop`);
    } catch (err) {
      setError('Failed to stop bot');
    }
  };

  const handleLogout = async () => {
    try {
      if (confirm('Are you sure you want to log out of this WhatsApp account?')) {
        await axios.post(`${API_URL}/logout`);
      }
    } catch (err) {
      setError('Failed to logout. See backend logs.');
      console.error(err);
    }
  };

  // --- Auth Screen (QR Setup) ---
  if (state.clientStatus !== 'CONNECTED') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
        {/* Background Gradients */}
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-whatsapp-dark/20 blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-whatsapp-light/10 blur-[120px]" />

        <div className="glass-panel w-full max-w-md p-8 text-center relative z-10">
          <div className="mb-6 flex justify-center">
            <div className="w-16 h-16 bg-whatsapp-light/20 rounded-2xl flex items-center justify-center">
              <Bot className="w-8 h-8 text-whatsapp-light" />
            </div>
          </div>
          <h1 className="text-2xl font-bold mb-2">Connect WhatsApp</h1>
          <p className="text-[#8696a0] mb-8 text-sm">
            Scan the QR code with your WhatsApp app to link your account.
          </p>

          <div className="bg-white p-4 rounded-xl inline-block mb-6 shadow-inner mx-auto min-h-[256px] min-w-[256px] flex items-center justify-center">
            {state.clientStatus === 'CONNECTING' && (
              <div className="flex flex-col items-center">
                <Loader2 className="w-8 h-8 text-whatsapp-dark animate-spin mb-3" />
                <span className="text-gray-600 font-medium">Initializing...</span>
              </div>
            )}
            {state.qr && (
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(state.qr)}`}
                alt="WhatsApp QR Code"
                className="w-64 h-64 object-contain animate-in fade-in zoom-in duration-300"
              />
            )}
            {!state.qr && state.clientStatus !== 'CONNECTING' && (
              <div className="flex flex-col items-center">
                <QrCode className="w-10 h-10 text-gray-300 mb-3" />
                <span className="text-gray-400">Waiting for QR...</span>
              </div>
            )}
          </div>

          <div className="text-sm text-[#8696a0] flex items-center justify-center gap-2">
            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            Waiting for scan...
          </div>
        </div>
      </div>
    );
  }

  // --- Main Dashboard Screen ---
  return (
    <div className="min-h-screen p-4 md:p-8 relative">
      {/* Background Gradients */}
      <div className="fixed top-0 left-0 w-[40%] h-[40%] rounded-full bg-whatsapp-dark/10 blur-[150px] -z-10" />

      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <header className="glass-panel p-4 px-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-whatsapp-light/20 rounded-xl flex items-center justify-center">
              <Bot className="w-5 h-5 text-whatsapp-light" />
            </div>
            <div>
              <h1 className="font-bold text-lg">WhatsApp Bot</h1>
              <div className="flex items-center gap-2 text-xs text-[#8696a0]">
                <div className="w-2 h-2 rounded-full bg-whatsapp-light shadow-[0_0_8px_#25D366]" />
                Connected
              </div>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-4">
              {state.isBotRunning ? (
                <span className="bg-whatsapp-light/20 text-whatsapp-light px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-2 border border-whatsapp-light/30">
                  <div className="w-1.5 h-1.5 rounded-full bg-whatsapp-light animate-ping" />
                  Bot Active
                </span>
              ) : (
                <span className="bg-[#2a3942] text-[#8696a0] px-3 py-1 rounded-full text-xs font-semibold">
                  Bot Idle
                </span>
              )}
              <button
                onClick={handleLogout}
                className="bg-red-500/10 text-red-500 hover:bg-red-500/20 p-2 rounded-lg transition-colors border border-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Logout / Switch Account"
                disabled={state.isBotRunning}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        <div className="grid md:grid-cols-12 gap-6">
          {/* Configuration Panel */}
          <div className="md:col-span-5 glass-panel p-6">
            <h2 className="text-lg font-bold mb-6 flex items-center gap-2 border-b border-[#2a3942] pb-4">
              <Play className="w-5 h-5 text-whatsapp-light" />
              Bot Configuration
            </h2>

            {error && (
              <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-400 p-3 rounded-lg text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleStart} className="space-y-5">
              {/* Send Mode Selection */}
              <div>
                <label className="block text-sm text-[#8696a0] font-medium mb-1.5 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  Target Mode
                </label>
                <div className="flex gap-4 mb-2">
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-200">
                    <input
                      type="radio"
                      name="sendMode"
                      value="group"
                      checked={sendMode === 'group'}
                      onChange={() => setSendMode('group')}
                      disabled={state.isBotRunning}
                      className="accent-whatsapp-light"
                    />
                    Group
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-200">
                    <input
                      type="radio"
                      name="sendMode"
                      value="numbers"
                      checked={sendMode === 'numbers'}
                      onChange={() => setSendMode('numbers')}
                      disabled={state.isBotRunning}
                      className="accent-whatsapp-light"
                    />
                    Specific Numbers
                  </label>
                </div>
              </div>

              {/* Target Group */}
              {sendMode === 'group' && (
                <div>
                  <label className="block text-sm text-[#8696a0] font-medium mb-1.5 flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    Target Group
                  </label>
                  <select
                    value={selectedGroup}
                    onChange={(e) => setSelectedGroup(e.target.value)}
                    className="input-field appearance-none"
                    disabled={state.isBotRunning || isLoadingGroups}
                  >
                    <option value="">Select a group...</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.name}>{g.name}</option>
                    ))}
                  </select>
                  {isLoadingGroups && <p className="text-xs text-whatsapp-light mt-2 animate-pulse">Loading groups...</p>}
                </div>
              )}

              {/* Target Numbers */}
              {sendMode === 'numbers' && (
                <div>
                  <label className="block text-sm text-[#8696a0] font-medium mb-1.5 flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    Target Numbers (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={targetNumbers}
                    onChange={(e) => setTargetNumbers(e.target.value)}
                    placeholder="e.g. 919876543210, 919876543211"
                    className="input-field"
                    disabled={state.isBotRunning}
                  />
                  <p className="text-xs text-[#8696a0] mt-1">Enter numbers with country code (e.g. 91 for India)</p>
                </div>
              )}

              {/* Message */}
              <div>
                <label className="block text-sm text-[#8696a0] font-medium mb-1.5 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  Message Content / Caption
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="input-field min-h-[120px] resize-none"
                  placeholder="Hello! This is an automated message..."
                  disabled={state.isBotRunning}
                />
              </div>

              {/* File Attachment */}
              <div>
                <label className="block text-sm text-[#8696a0] font-medium mb-1.5 flex items-center gap-2">
                  <Paperclip className="w-4 h-4" />
                  Attach File (Optional)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="file"
                    id="file-upload"
                    onChange={handleFileChange}
                    disabled={state.isBotRunning}
                    className="hidden"
                  />
                  <label htmlFor="file-upload" className={`btn-primary !w-auto !py-2 !px-4 cursor-pointer cursor-pointer ${state.isBotRunning ? 'opacity-50 pointer-events-none' : ''}`}>
                    Choose File
                  </label>
                  {fileName && (
                    <div className="flex items-center gap-2 text-sm text-whatsapp-light bg-whatsapp-light/10 px-3 py-1.5 rounded-lg border border-whatsapp-light/20">
                      <Paperclip className="w-4 h-4" />
                      <span className="truncate max-w-[150px]">{fileName}</span>
                      {!state.isBotRunning && (
                        <button type="button" onClick={clearFile} className="hover:text-red-400 ml-1">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Interval */}
              <div>
                <label className="block text-sm text-[#8696a0] font-medium mb-1.5 flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Delay Interval (Minutes)
                </label>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <input
                      type="number"
                      min="1"
                      value={minDelay}
                      onChange={(e) => setMinDelay(e.target.value)}
                      className="input-field text-center"
                      disabled={state.isBotRunning}
                      required
                    />
                    <div className="text-[10px] text-center text-[#8696a0] mt-1 drop-shadow-sm">MIN</div>
                  </div>
                  <div className="text-[#8696a0] font-bold">to</div>
                  <div className="flex-1">
                    <input
                      type="number"
                      min="1"
                      value={maxDelay}
                      onChange={(e) => setMaxDelay(e.target.value)}
                      className="input-field text-center"
                      disabled={state.isBotRunning}
                      required
                    />
                    <div className="text-[10px] text-center text-[#8696a0] mt-1 drop-shadow-sm">MAX</div>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-[#2a3942]">
                {!state.isBotRunning ? (
                  <button type="submit" className="btn-primary" disabled={isLoadingGroups}>
                    <Play className="w-5 h-5" fill="currentColor" />
                    Start Bot
                  </button>
                ) : (
                  <button type="button" onClick={handleStop} className="btn-danger">
                    <Square className="w-5 h-5" fill="currentColor" />
                    Stop Bot
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Activity Log */}
          <div className="md:col-span-7 glass-panel flex flex-col h-[600px] md:h-auto">
            <div className="p-4 px-6 border-b border-[#2a3942] flex justify-between items-center bg-[#202c33]/50 rounded-t-xl">
              <h2 className="font-bold text-sm tracking-wider text-[#8696a0] uppercase flex items-center gap-2">
                Activity Log
              </h2>
            </div>

            <div className="flex-1 p-4 overflow-y-auto space-y-3 font-mono text-sm bg-black/20 rounded-b-xl shadow-inner">
              {logs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-[#8696a0]/50 gap-3">
                  <Bot className="w-12 h-12" />
                  <p>No activity yet.</p>
                </div>
              ) : (
                logs.map(log => (
                  <div key={log.id} className="flex gap-3 text-[#d1d7db] animate-in slide-in-from-left-2 duration-300">
                    <span className="text-whatsapp-dark shrink-0">➜</span>
                    <span>{log.text}</span>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
