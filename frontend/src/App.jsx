import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Bot, Play, Square, Loader2, QrCode, MessageSquare, AlertCircle, Clock, CheckCircle2, LogOut, Paperclip, X, PlusCircle, LayoutDashboard, Settings, Trash2, RefreshCw } from 'lucide-react';
import axios from 'axios';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? window.location.origin : 'http://127.0.0.1:3001');
const socket = io(BACKEND_URL, {
  transports: ['polling', 'websocket'],
  reconnectionAttempts: 5,
  timeout: 20000
});
const API_URL = `${BACKEND_URL}/api`;

function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState('default');
  
  const [state, setState] = useState({
    clientStatus: 'DISCONNECTED',
    qr: null,
    isBotRunning: false,
    autoMessageTargetGroup: '',
    autoMessageText: '',
    minIntervalActive: 15,
    maxIntervalActive: 20
  });

  const [groups, setGroups] = useState([]);
  const [sessionLogs, setSessionLogs] = useState({}); // Logs keyed by sessionId
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const [error, setError] = useState('');
  const [isAddingSession, setIsAddingSession] = useState(false);

  // Form State
  const [sendMode, setSendMode] = useState('group');
  const [targetNumbers, setTargetNumbers] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [message, setMessage] = useState('');
  const [fileData, setFileData] = useState(null);
  const [fileName, setFileName] = useState('');
  const [minDelay, setMinDelay] = useState(15);
  const [maxDelay, setMaxDelay] = useState(20);

  const logsEndRef = useRef(null);

  useEffect(() => {
    fetchSessions();

    socket.on('state-update', (newState) => {
      if (newState.sessionId === activeSessionId) {
        setState(newState);
        if (newState.isBotRunning) {
          setSendMode(newState.autoMessageSendMode || 'group');
          setSelectedGroup(newState.autoMessageTargetGroup || '');
          setTargetNumbers(newState.autoMessageTargetNumbers || '');
          setMessage(newState.autoMessageText);
          setMinDelay(newState.minIntervalActive);
          setMaxDelay(newState.maxIntervalActive);
        }
        updateSessionInList(newState);
      } else {
        updateSessionInList(newState);
      }
    });

    socket.on('log', (logData) => {
      // logData: { sessionId, text, timestamp }
      const sid = typeof logData === 'string' ? activeSessionId : logData.sessionId;
      const text = typeof logData === 'string' ? logData : logData.text;
      
      setSessionLogs(prev => ({
        ...prev,
        [sid]: [...(prev[sid] || []), { id: Date.now() + Math.random(), text }]
      }));
    });

    socket.on('connect', () => {
      console.log('Successfully connected to socket server');
      const text = 'Connected to live server!';
      setSessionLogs(prev => ({
        ...prev,
        [activeSessionId]: [...(prev[activeSessionId] || []), { id: Date.now(), text }]
      }));
      socket.emit('join-session', activeSessionId);
    });

    socket.on('connect_error', (error) => {
      const text = `Connection Error: ${error.message}`;
      setSessionLogs(prev => ({
        ...prev,
        [activeSessionId]: [...(prev[activeSessionId] || []), { id: Date.now(), text }]
      }));
    });

    return () => {
      socket.off('state-update');
      socket.off('log');
    };
  }, [activeSessionId]);

  useEffect(() => {
    if (socket.connected) {
      socket.emit('join-session', activeSessionId);
      // Removed setLogs([]) call to persist logs
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (state.clientStatus === 'CONNECTED') {
      fetchGroups();
    } else {
      setGroups([]);
    }
  }, [state.clientStatus, activeSessionId]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sessionLogs, activeSessionId]);

  const fetchSessions = async () => {
    try {
      const { data } = await axios.get(`${API_URL}/sessions`);
      setSessions(data.sessions);
      if (data.sessions.length > 0 && !activeSessionId) {
        setActiveSessionId(data.sessions[0].id);
      }
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    }
  };

  const addSession = async () => {
    const sessionId = prompt('Enter a name for this WhatsApp session (e.g. Sales, Support):');
    if (!sessionId) return;

    setIsAddingSession(true);
    try {
      const { data } = await axios.post(`${API_URL}/sessions`, { sessionId });
      if (data.success) {
        await fetchSessions();
        setActiveSessionId(data.sessionId);
      }
    } catch (err) {
      setError(`Failed to add session: ${err.response?.data?.error || err.message}`);
    } finally {
      setIsAddingSession(false);
    }
  };

  const updateSessionInList = (sessionData) => {
    setSessions(prev => 
      prev.map(s => s.id === sessionData.sessionId 
        ? { ...s, status: sessionData.clientStatus, isBotRunning: sessionData.isBotRunning }
        : s
      )
    );
  };

  const fetchGroups = async () => {
    setIsLoadingGroups(true);
    try {
      const { data } = await axios.get(`${API_URL}/groups?sessionId=${activeSessionId}`);
      setGroups(data.groups);
      if (data.groups.length > 0 && !selectedGroup) {
        // Find if current group is in the list
        if (!data.groups.find(g => g.name === selectedGroup)) {
          setSelectedGroup(data.groups[0].name);
        }
      }
    } catch (err) {
      setError(`Failed to load groups: ${err.message}`);
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
        sessionId: activeSessionId,
        sendMode,
        groupName: sendMode === 'group' ? selectedGroup : '',
        targetNumbers: sendMode === 'numbers' ? targetNumbers : '',
        message,
        minSeconds: Number(minDelay),
        maxSeconds: Number(maxDelay),
        media: fileData
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start bot');
    }
  };

  const handleStop = async () => {
    try {
      await axios.post(`${API_URL}/stop`, { sessionId: activeSessionId });
    } catch (err) {
      setError('Failed to stop bot');
    }
  };

  const handleLogout = async () => {
    try {
      if (confirm(`Are you sure you want to log out of the "${activeSessionId}" WhatsApp account?`)) {
        await axios.post(`${API_URL}/logout`, { sessionId: activeSessionId });
      }
    } catch (err) {
      setError('Failed to logout. See backend logs.');
    }
  };

  const deleteSession = async (sessionId, e) => {
    e.stopPropagation(); // Don't switch to the session when deleting
    if (confirm(`Are you sure you want to DELETE the session "${sessionId}" and all its local data? This cannot be undone.`)) {
      try {
        await axios.delete(`${API_URL}/sessions/${sessionId}`);
        await fetchSessions();
        if (activeSessionId === sessionId) {
          setActiveSessionId(sessions.find(s => s.id !== sessionId)?.id || 'default');
        }
        setSessionLogs(prev => {
          const newLogs = { ...prev };
          delete newLogs[sessionId];
          return newLogs;
        });
      } catch (err) {
        setError(`Failed to delete session: ${err.message}`);
      }
    }
  };

  const refreshQR = async () => {
    try {
      await axios.post(`${API_URL}/logout`, { sessionId: activeSessionId });
      const text = 'Refreshing QR code...';
      setSessionLogs(prev => ({
        ...prev,
        [activeSessionId]: [...(prev[activeSessionId] || []), { id: Date.now(), text }]
      }));
    } catch (err) {
      setError('Failed to refresh QR');
    }
  };

  return (
    <div className="min-h-screen flex bg-[#0c1317] text-[#d1d7db] relative">
      {/* Background Gradients */}
      <div className="fixed top-0 left-0 w-[40%] h-[40%] rounded-full bg-whatsapp-dark/10 blur-[150px] -z-10" />

      {/* Sidebar */}
      <aside className="w-72 bg-[#111b21] border-r border-[#2a3942] flex flex-col shrink-0">
        <div className="p-6 border-b border-[#2a3942] flex items-center gap-3">
          <div className="w-10 h-10 bg-whatsapp-light/20 rounded-xl flex items-center justify-center">
            <Bot className="w-5 h-5 text-whatsapp-light" />
          </div>
          <h1 className="font-bold text-lg">WhatsApp Bot</h1>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-bold text-[#8696a0] uppercase tracking-wider">Sessions</h2>
            <button 
              onClick={addSession}
              disabled={isAddingSession}
              className="text-whatsapp-light hover:text-whatsapp-dark transition-colors"
            >
              <PlusCircle className="w-5 h-5" />
            </button>
          </div>

          {sessions.map((s) => (
            <div key={s.id} className="group relative">
              <button
                onClick={() => setActiveSessionId(s.id)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all ${
                  activeSessionId === s.id 
                    ? 'bg-[#2a3942] text-white' 
                    : 'hover:bg-[#202c33] text-[#8696a0]'
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${
                  s.status === 'CONNECTED' ? 'bg-whatsapp-light shadow-[0_0_8px_#25D366]' : 'bg-gray-600'
                }`} />
                <span className="flex-1 text-left font-medium truncate">{s.id}</span>
                {s.isBotRunning && (
                  <div className="w-1.5 h-1.5 rounded-full bg-whatsapp-light animate-ping" />
                )}
              </button>
              {s.id !== 'default' && (
                <button
                  onClick={(e) => deleteSession(s.id, e)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1.5 hover:text-red-500 transition-all text-[#8696a0]"
                  title="Delete Session"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-[#2a3942]">
          <div className="text-[10px] text-[#8696a0] text-center">
            Multi-Session Manager v1.0
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {state.clientStatus !== 'CONNECTED' ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="glass-panel w-full max-w-md p-8 text-center relative z-10">
              <div className="mb-6 flex justify-center">
                <div className="w-16 h-16 bg-whatsapp-light/20 rounded-2xl flex items-center justify-center">
                  <Bot className="w-8 h-8 text-whatsapp-light" />
                </div>
              </div>
              <h1 className="text-2xl font-bold mb-2">Connect "{activeSessionId}"</h1>
              <p className="text-[#8696a0] mb-8 text-sm">
                Scan the QR code with your WhatsApp app to link this account.
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

              <div className="text-sm text-[#8696a0] flex flex-col items-center gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                  Waiting for scan...
                </div>
                
                <button 
                  onClick={refreshQR}
                  className="flex items-center gap-2 text-whatsapp-light hover:text-whatsapp-dark transition-colors px-4 py-2 rounded-lg bg-whatsapp-light/10 border border-whatsapp-light/20"
                >
                  <RefreshCw className="w-4 h-4" />
                  Reload QR Code
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 p-6 md:p-8 space-y-6 overflow-y-auto">
            {/* Header */}
            <header className="glass-panel p-4 px-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-whatsapp-light/20 rounded-xl flex items-center justify-center">
                  <Bot className="w-5 h-5 text-whatsapp-light" />
                </div>
                <div>
                  <h1 className="font-bold text-lg">Session: {activeSessionId}</h1>
                  <div className="flex items-center gap-2 text-xs text-[#8696a0]">
                    <div className="w-2 h-2 rounded-full bg-whatsapp-light shadow-[0_0_8px_#25D366]" />
                    Connected
                  </div>
                </div>
              </div>
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
                  title="Logout Session"
                  disabled={state.isBotRunning}
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            </header>

            <div className="grid lg:grid-cols-12 gap-6">
              {/* Configuration Panel */}
              <div className="lg:col-span-5 glass-panel p-6">
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
                      className="input-field min-h-[100px] resize-none"
                      placeholder="Hello! This is an automated message..."
                      disabled={state.isBotRunning}
                    />
                  </div>

                  {/* File Attachment */}
                  <div>
                    <label className="block text-sm text-[#8696a0] font-medium mb-1.5 flex items-center gap-2">
                      <Paperclip className="w-4 h-4" />
                      Attach File
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="file"
                        id="file-upload"
                        onChange={handleFileChange}
                        disabled={state.isBotRunning}
                        className="hidden"
                      />
                      <label htmlFor="file-upload" className={`btn-primary !w-auto !py-2 !px-4 cursor-pointer ${state.isBotRunning ? 'opacity-50 pointer-events-none' : ''}`}>
                        Choose File
                      </label>
                      {fileName && (
                        <div className="flex items-center gap-2 text-xs text-whatsapp-light bg-whatsapp-light/10 px-2 py-1 rounded border border-whatsapp-light/20 truncate max-w-[150px]">
                          <span className="truncate">{fileName}</span>
                          {!state.isBotRunning && (
                            <button type="button" onClick={clearFile} className="hover:text-red-400">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Interval */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[10px] text-[#8696a0] uppercase mb-1">Min Delay (Sec)</label>
                      <input
                        type="number"
                        min="5"
                        value={minDelay}
                        onChange={(e) => setMinDelay(e.target.value)}
                        className="input-field text-center"
                        disabled={state.isBotRunning}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-[#8696a0] uppercase mb-1">Max Delay (Sec)</label>
                      <input
                        type="number"
                        min="5"
                        value={maxDelay}
                        onChange={(e) => setMaxDelay(e.target.value)}
                        className="input-field text-center"
                        disabled={state.isBotRunning}
                        required
                      />
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
              <div className="lg:col-span-7 glass-panel flex flex-col min-h-[400px]">
                <div className="p-4 px-6 border-b border-[#2a3942] flex justify-between items-center bg-[#202c33]/50 rounded-t-xl">
                  <h2 className="font-bold text-sm tracking-wider text-[#8696a0] uppercase flex items-center gap-2">
                    Activity Log - {activeSessionId}
                  </h2>
                </div>

                <div className="flex-1 p-4 overflow-y-auto space-y-3 font-mono text-sm bg-black/20 rounded-b-xl">
                  {(!sessionLogs[activeSessionId] || sessionLogs[activeSessionId].length === 0) ? (
                    <div className="h-full flex flex-col items-center justify-center text-[#8696a0]/30 gap-3">
                      <Bot className="w-12 h-12" />
                      <p>No activity for "{activeSessionId}" yet.</p>
                    </div>
                  ) : (
                    sessionLogs[activeSessionId].map(log => (
                      <div key={log.id} className="flex gap-3 text-[#d1d7db] animate-in slide-in-from-left-2">
                        <span className="text-whatsapp-dark shrink-0">➜</span>
                        <span className="break-all">{log.text}</span>
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
